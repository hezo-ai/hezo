import { HeartbeatRunStatus, WakeupSource, WakeupStatus } from '@hezo/shared';
import type { Db } from '../db/database';
import { trackBackground } from '../lib/background';
import { logger } from '../logger';

const log = logger.child('wakeup');

/**
 * Queue a wakeup.
 *
 * `createdByRunId` records the agent run whose write caused it, when there is
 * one. The no-wake exit check reads it back to answer "did this run notify the
 * teammates it named?", which it cannot derive from the run's comments: an
 * assignment, a reassignment and a released blocker all notify someone without
 * anybody writing an @-mention. Null is the correct value for every wakeup no
 * run caused - a heartbeat, a timer, an operator pressing Run now, a sweep.
 *
 * All three write paths below stamp it. Missing one loses the attribution
 * intermittently, depending only on whether a queued wakeup already existed.
 */
export async function createWakeup(
	db: Db,
	memberId: string,
	teamId: string,
	source: WakeupSource,
	payload: Record<string, unknown> = {},
	idempotencyKey?: string,
	createdByRunId?: string | null,
): Promise<string> {
	if (idempotencyKey) {
		const existing = await db.query<{ id: string }>(
			`SELECT id FROM agent_wakeup_requests
			 WHERE idempotency_key = $1 AND status = $2::wakeup_status`,
			[idempotencyKey, WakeupStatus.Queued],
		);
		if (existing.rows.length > 0) {
			// The trigger still happened even though it wrote no new row, so the
			// run that fired it gets the credit for reaching this agent.
			if (createdByRunId) {
				await db.query(`UPDATE agent_wakeup_requests SET created_by_run_id = $1 WHERE id = $2`, [
					createdByRunId,
					existing.rows[0].id,
				]);
			}
			return existing.rows[0].id;
		}
	}

	// Collapse onto any pending (still-queued) wakeup for the same agent and
	// target task. A single pending run picks up everything that accumulated
	// since it was queued, so an agent never needs more than one queued wakeup
	// per task — regardless of how far apart the triggers arrive.
	//
	// Marker-carrying wakeups (`payload.trigger`, e.g. the Captain's queued
	// manual progress-update run) are never coalesce targets: callers activate
	// with their own local payload, so absorbing the marked row would strand its
	// marker and let the claim bypass the trigger's dedicated dispatch path.
	const taskId = typeof payload.task_id === 'string' ? payload.task_id : null;
	const coalesceResult = await db.query<{ id: string; payload: Record<string, unknown> }>(
		`SELECT id, payload FROM agent_wakeup_requests
		 WHERE member_id = $1 AND status = $2::wakeup_status
		   AND payload->>'trigger' IS NULL
		   AND (($3::text IS NULL AND payload->>'task_id' IS NULL)
		     OR payload->>'task_id' = $3::text)
		 ORDER BY created_at DESC LIMIT 1`,
		[memberId, WakeupStatus.Queued, taskId],
	);

	if (coalesceResult.rows.length > 0) {
		const existingRow = coalesceResult.rows[0];
		const mergedPayload = mergePayloads(existingRow.payload, payload);

		// Guard against the dispatcher claiming the row between the SELECT and
		// here. If it already moved out of `queued`, fall through to a fresh
		// insert so this trigger still produces a pending run.
		//
		// The attribution uses `COALESCE` so a run claims the row it just
		// contributed to, while a write with no run behind it leaves an existing
		// attribution alone rather than erasing it. One column cannot hold two
		// runs, so where two concurrent runs notify the same agent about the same
		// task only the later is credited; the check warns rather than acts, so the
		// cost of that is a spurious warning, never a missed one.
		const merged = await db.query<{ id: string }>(
			`UPDATE agent_wakeup_requests
			 SET coalesced_count = coalesced_count + 1,
			     payload = $1::jsonb,
			     created_by_run_id = COALESCE($4::uuid, created_by_run_id)
			 WHERE id = $2 AND status = $3::wakeup_status
			 RETURNING id`,
			[JSON.stringify(mergedPayload), existingRow.id, WakeupStatus.Queued, createdByRunId ?? null],
		);

		if (merged.rows.length > 0) {
			return existingRow.id;
		}
	}

	const result = await db.query<{ id: string }>(
		`INSERT INTO agent_wakeup_requests
		   (member_id, team_id, source, payload, idempotency_key, created_by_run_id)
		 VALUES ($1, $2, $3::wakeup_source, $4::jsonb, $5, $6)
		 RETURNING id`,
		[
			memberId,
			teamId,
			source,
			JSON.stringify(payload),
			idempotencyKey ?? null,
			createdByRunId ?? null,
		],
	);

	return result.rows[0].id;
}

/**
 * Idempotently create the Captain's manual ("Run now") progress-update wakeup.
 *
 * Unlike a task wakeup, a progress-update wakeup is task-less, so `createWakeup`
 * would coalesce it onto the Captain's *scheduled* task-less heartbeat wakeup
 * (same member, `task_id IS NULL`) — merging the two and blurring the
 * `progress_update_now` marker. This helper never coalesces: it returns any
 * existing still-queued progress wakeup for the Captain (so clicking "Run now"
 * twice yields one row) or inserts a fresh, uniquely-keyed one. The reverse
 * direction is covered in `createWakeup`, whose coalesce query skips
 * marker-carrying rows — so a scheduled heartbeat can never claim (and then
 * mis-dispatch) the queued manual run. The `progress_update_now:<captain>`
 * idempotency key both dedups and lets the list/cancel routes target the row
 * precisely.
 */
export async function createProgressUpdateWakeup(
	db: Db,
	captainMemberId: string,
	teamId: string,
	projectId: string,
	source: WakeupSource,
	triggeredBy?: { member_id: string; name: string } | null,
): Promise<string> {
	const idempotencyKey = `progress_update_now:${captainMemberId}`;

	const existing = await db.query<{ id: string }>(
		`SELECT id FROM agent_wakeup_requests
		 WHERE member_id = $1 AND status = $2::wakeup_status
		   AND payload->>'trigger' = 'progress_update_now'
		 LIMIT 1`,
		[captainMemberId, WakeupStatus.Queued],
	);
	if (existing.rows.length > 0) return existing.rows[0].id;

	const payload = {
		source,
		trigger: 'progress_update_now',
		project_id: projectId,
		...(triggeredBy ? { triggered_by: triggeredBy } : {}),
	};
	const result = await db.query<{ id: string }>(
		`INSERT INTO agent_wakeup_requests (member_id, team_id, source, payload, idempotency_key)
		 VALUES ($1, $2, $3::wakeup_source, $4::jsonb, $5)
		 RETURNING id`,
		[captainMemberId, teamId, source, JSON.stringify(payload), idempotencyKey],
	);
	return result.rows[0].id;
}

/**
 * Retire every still-queued wakeup for one agent + task except the one that is
 * driving the run that is about to start. A run reads the full task context at
 * boot, so any trigger already queued when it starts is served by that run;
 * leaving the siblings queued would fire a redundant back-to-back run once the
 * task frees up. Only `queued` rows are touched — `deferred` (blocker-parked)
 * wakeups stay put for the unblock path, and triggers created after the run
 * starts remain queued to drive a legitimate follow-up. Returns the ids that
 * were absorbed so the caller can refresh any task-derived UI.
 */
export async function absorbQueuedTaskWakeups(
	db: Db,
	memberId: string,
	taskId: string,
	exceptWakeupId: string,
): Promise<string[]> {
	const absorbed = await db.query<{ id: string }>(
		`UPDATE agent_wakeup_requests
		 SET status = $1::wakeup_status
		 WHERE member_id = $2
		   AND status = $3::wakeup_status
		   AND payload->>'task_id' = $4
		   AND id <> $5
		 RETURNING id`,
		[WakeupStatus.Coalesced, memberId, WakeupStatus.Queued, taskId, exceptWakeupId],
	);
	return absorbed.rows.map((r) => r.id);
}

/**
 * True when a successful run for this agent+task already started at or after the
 * wakeup was created — the run read the task at boot and served the assignment,
 * so starting another would be a no-op repeat. Closes the gap that
 * `absorbQueuedTaskWakeups` leaves at run *start*: a blocker-deferred or
 * busy-skipped `assignment` wakeup that only becomes claimable after the run has
 * already worked the task. Scoped to `succeeded` runs so a failed/timed-out run
 * still allows a legitimate retry, and an assignment created *after* the last run
 * (`created_at > started_at`) is never suppressed.
 */
export async function assignmentWakeupAlreadyServed(
	db: Db,
	memberId: string,
	taskId: string,
	wakeupCreatedAt: string,
): Promise<boolean> {
	const served = await db.query<{ id: string }>(
		`SELECT id FROM heartbeat_runs
		 WHERE member_id = $1
		   AND task_id = $2
		   AND status = $3::heartbeat_run_status
		   AND started_at IS NOT NULL
		   AND started_at >= $4
		 LIMIT 1`,
		[memberId, taskId, HeartbeatRunStatus.Succeeded, wakeupCreatedAt],
	);
	return served.rows.length > 0;
}

function mergePayloads(
	existing: Record<string, unknown>,
	incoming: Record<string, unknown>,
): Record<string, unknown> {
	const merged = { ...existing };

	for (const [key, value] of Object.entries(incoming)) {
		if (Array.isArray(existing[key]) && Array.isArray(value)) {
			merged[key] = [...(existing[key] as unknown[]), ...value];
		} else if (value !== undefined) {
			merged[key] = value;
		}
	}

	return merged;
}

// The agent's run is inherently async, so most callers don't await this. The
// whole body — including the member-agent lookup — is wrapped in
// trackBackground + catch so a rejection from either query can't surface as an
// unhandled rejection or race test teardown (the tracker is drained on close).
//
// It returns the tracked promise so a caller inside an agent run CAN await it:
// that run's own no-wake exit check reads the row back at the end of the run, so
// a reassignment made as the last action would otherwise land after the check
// and be reported as a handoff that notified nobody. Awaiting is safe - the
// catch is inside the promise, so it never rejects.
//
// Humans get no wakeup, hence the member_agents lookup rather than a bare insert.
export function wakeAgentIfAssigned(
	db: Db,
	assigneeId: string | null | undefined,
	teamId: string,
	taskId: string,
	source: WakeupSource = WakeupSource.Assignment,
	extraPayload: Record<string, unknown> = {},
	createdByRunId: string | null = null,
): Promise<void> {
	if (!assigneeId) return Promise.resolve();
	return trackBackground(
		(async () => {
			const isAgent = await db.query('SELECT id FROM member_agents WHERE id = $1', [assigneeId]);
			if (isAgent.rows.length === 0) return;
			await createWakeup(
				db,
				assigneeId,
				teamId,
				source,
				{ task_id: taskId, ...extraPayload },
				undefined,
				createdByRunId,
			);
		})().catch((e) => log.error('Failed to create wakeup for assignment:', e)),
	);
}
