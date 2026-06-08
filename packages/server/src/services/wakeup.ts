import type { PGlite } from '@electric-sql/pglite';
import { HeartbeatRunStatus, type WakeupSource, WakeupStatus } from '@hezo/shared';

export async function createWakeup(
	db: PGlite,
	memberId: string,
	teamId: string,
	source: WakeupSource,
	payload: Record<string, unknown> = {},
	idempotencyKey?: string,
): Promise<string> {
	if (idempotencyKey) {
		const existing = await db.query<{ id: string }>(
			`SELECT id FROM agent_wakeup_requests
			 WHERE idempotency_key = $1 AND status = $2::wakeup_status`,
			[idempotencyKey, WakeupStatus.Queued],
		);
		if (existing.rows.length > 0) {
			return existing.rows[0].id;
		}
	}

	// Collapse onto any pending (still-queued) wakeup for the same agent and
	// target task. A single pending run picks up everything that accumulated
	// since it was queued, so an agent never needs more than one queued wakeup
	// per task — regardless of how far apart the triggers arrive.
	const taskId = typeof payload.task_id === 'string' ? payload.task_id : null;
	const coalesceResult = await db.query<{ id: string; payload: Record<string, unknown> }>(
		`SELECT id, payload FROM agent_wakeup_requests
		 WHERE member_id = $1 AND status = $2::wakeup_status
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
		const merged = await db.query<{ id: string }>(
			`UPDATE agent_wakeup_requests
			 SET coalesced_count = coalesced_count + 1,
			     payload = $1::jsonb
			 WHERE id = $2 AND status = $3::wakeup_status
			 RETURNING id`,
			[JSON.stringify(mergedPayload), existingRow.id, WakeupStatus.Queued],
		);

		if (merged.rows.length > 0) {
			return existingRow.id;
		}
	}

	const result = await db.query<{ id: string }>(
		`INSERT INTO agent_wakeup_requests (member_id, team_id, source, payload, idempotency_key)
		 VALUES ($1, $2, $3::wakeup_source, $4::jsonb, $5)
		 RETURNING id`,
		[memberId, teamId, source, JSON.stringify(payload), idempotencyKey ?? null],
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
	db: PGlite,
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
	db: PGlite,
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
