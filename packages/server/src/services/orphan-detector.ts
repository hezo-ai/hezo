import {
	AgentRuntimeStatus,
	ApprovalType,
	HeartbeatRunStatus,
	WakeupSkipReason,
	WakeupSource,
	WakeupStatus,
	wsRoom,
} from '@hezo/shared';
import type { Db } from '../db/database';
import { readRunLogTail } from '../db/run-log-chunks';
import { broadcastRowChange } from '../lib/broadcast';
import { logger } from '../logger';
import { setAgentIdleIfNoActiveRuns } from './agent-runtime-status';
import { createWakeup } from './wakeup';
import type { WebSocketManager } from './ws';

const log = logger.child('orphan-detector');

const MAX_RETRIES = 3;
const SAFETY_WINDOW_SECONDS = 30;
/** Failure excerpt handed to the retry wakeup. */
const ORPHAN_LOG_TAIL_CHARS = 1_000;
/**
 * Orphans reaped per pass. The scan was previously unbounded, so a backlog (a
 * crash that stranded every live run, a long outage) put an arbitrarily large
 * result set and an arbitrarily long serial repair loop on a 30s cron. The
 * remainder is picked up on the next tick.
 */
const MAX_ORPHANS_PER_PASS = 50;
/** How long DB state may disagree with the absence of any active run before
 * the heal pass repairs it. Long enough to cover the dispatch window (status
 * flips active before the run row lands) and normal completion bookkeeping.
 * Doubles as the age a `queued` run must reach before the orphan pass will
 * reap it, since that window likewise spans the whole not-yet-started phase. */
export const STALE_STATE_GRACE_SECONDS = 120;

export interface DetectOrphansOpts {
	/**
	 * Best-effort reaper for the orphaned run's in-container process tree
	 * (`ContainerEngine.killRunProcesses`). A run row can outlive its host-side
	 * driver while the exec'd agent CLI keeps running in the container — when
	 * the detector declares the run orphaned, the tree must die with it.
	 */
	killProcesses?: (containerId: string, runId: string) => Promise<void>;
}

/**
 * How much of the log tail rides along in the run's `error`.
 *
 * Shorter than the excerpt handed to a retry wakeup: this one is rendered in a
 * fixed-height block on the run detail page, and the point is to say *why*
 * without the reader having to go and read the log themselves.
 */
const ORPHAN_ERROR_TAIL_CHARS = 400;

/**
 * The run's `error`, carrying the actual cause where the log has one.
 *
 * The bare verdict on its own ("run never started") named the symptom and left
 * the reason - almost always the instance being at its container-memory budget -
 * sitting in a log the reader had to open separately.
 */
function orphanErrorMessage(neverStarted: boolean, logTail: string): string {
	const verdict = neverStarted
		? 'Never started: no host process was driving this run, so it was returned to the queue.'
		: // Says what was observed rather than what was inferred. This pass performs
			// no process check - it finds a `running` row that no live run in this
			// process claims - and the old wording ("process no longer running")
			// asserted one, which read as a fact while being a guess. It was also the
			// text every setup failure ended up wearing, because those runs threw
			// without recording anything and this was the only writer left.
			'Orphaned: nothing was driving this run any more, so no result was ever recorded. ' +
			'A restart, a crash or a wedged dispatch - not the agent failing.';
	const excerpt = logTail.trim().slice(-ORPHAN_ERROR_TAIL_CHARS).trim();
	return excerpt ? `${verdict}\n\nLast log output:\n${excerpt}` : verdict;
}

/**
 * Hand a claimed wakeup back to the queue. Returns whether it was still claimed.
 *
 * The status guard is load-bearing: another path may have settled this wakeup
 * already, and returning a completed one to the queue dispatches its work a
 * second time. The boolean is how the caller knows whether the work was handed
 * back or still needs a retry raised for it.
 */
async function requeueWakeup(db: Db, wakeupId: string): Promise<boolean> {
	const res = await db.query(
		`UPDATE agent_wakeup_requests
		 SET status = $1::wakeup_status, claimed_at = NULL,
		     last_skipped_at = now(), last_skipped_reason = $2
		 WHERE id = $3 AND status = $4::wakeup_status
		 RETURNING id`,
		[WakeupStatus.Queued, WakeupSkipReason.InstanceAtCapacity, wakeupId, WakeupStatus.Claimed],
	);
	return res.rows.length > 0;
}

export async function detectOrphans(
	db: Db,
	liveRunIds: Set<string>,
	wsManager?: WebSocketManager,
	opts?: DetectOrphansOpts,
): Promise<number> {
	// Both non-terminal states can be stranded, and each needs its own clock.
	// A `running` run has a `started_at` to age against. A `queued` one never
	// started — `started_at` is NULL — so it ages against `created_at`, and it
	// gets the longer grace window because the gap between the row landing and
	// the run going live legitimately covers credential-lock waits and container
	// setup. Without this arm a queued row whose driver died before
	// `markHeartbeatRunRunning` is never reaped: it pins the task's
	// `has_active_run` (blocking reassignment and reading as a live run in the
	// UI) until the next server restart, since `healStaleRunState` counts
	// `queued` as active too.
	const orphans = await db.query<{
		id: string;
		member_id: string;
		team_id: string;
		task_id: string | null;
		wakeup_id: string | null;
		project_id: string | null;
		container_id: string | null;
		process_loss_retry_count: number;
		status: HeartbeatRunStatus;
	}>(
		`SELECT hr.id, hr.member_id, hr.team_id, hr.task_id, hr.wakeup_id,
		        hr.process_loss_retry_count, hr.status,
		        -- The team fallback is load-bearing for the broadcast, not a nicety.
		        -- A progress-update run carries no task, so the task lookup alone
		        -- left project_id NULL - and the client skips a heartbeat_runs
		        -- change it cannot map to a project (PROJECT_STRICT_TABLES), so
		        -- those reaps reached no open page at all. A team owns exactly one
		        -- project (UNIQUE(projects.team_id)), so this is unambiguous.
		        COALESCE(
		          (SELECT t.project_id FROM tasks t WHERE t.id = hr.task_id),
		          (SELECT p.id FROM projects p WHERE p.team_id = hr.team_id)
		        ) AS project_id,
		        (SELECT p.container_id FROM projects p JOIN tasks t ON t.project_id = p.id
		         WHERE t.id = hr.task_id) AS container_id
		 FROM heartbeat_runs hr
		 WHERE (hr.status = $1::heartbeat_run_status
		        AND hr.started_at < now() - ($2 || ' seconds')::interval)
		    OR (hr.status = $3::heartbeat_run_status
		        AND hr.created_at < now() - ($4 || ' seconds')::interval)
		 ORDER BY hr.created_at ASC
		 LIMIT $5`,
		[
			HeartbeatRunStatus.Running,
			String(SAFETY_WINDOW_SECONDS),
			HeartbeatRunStatus.Queued,
			String(STALE_STATE_GRACE_SECONDS),
			MAX_ORPHANS_PER_PASS,
		],
	);

	let orphanCount = 0;

	for (const run of orphans.rows) {
		// The live registry is populated the moment the run row is inserted
		// (`onRunRegistered` in agent-runner), so a queued run still owned by a
		// host-side driver — waiting on the credential lock, say — is skipped
		// here exactly like a healthy running one.
		if (liveRunIds.has(run.id)) continue;

		// The two arms are not the same event, and giving them one verdict was the
		// bug. A `running` run had a process doing work that vanished mid-flight:
		// output may be half-written, the container may hold a wedged tree, and the
		// agent's turn was spent - a failure. A `queued` one never started, so
		// nothing was produced and nothing was lost; the honest record is the one
		// the capacity park already writes when it gives up, `Cancelled` with the
		// work handed back. Failing it instead filled the Errored view with rows
		// nobody could act on, and minted a fresh retry wakeup on every pass rather
		// than returning the one already sitting there claimed.
		const neverStarted = run.status === HeartbeatRunStatus.Queued;

		// Read once and use twice - the message below and, on the failure arm, the
		// retry wakeup's excerpt. This runs on a 30s cron, so a second read per
		// orphan is a cost with nothing to show for it.
		const tail = await readRunLogTail(db, run.id, ORPHAN_LOG_TAIL_CHARS);
		const error = orphanErrorMessage(neverStarted, tail.text);

		const reaped = await db.query<{ id: string }>(
			`UPDATE heartbeat_runs
			 SET status = $2::heartbeat_run_status,
			     finished_at = now(),
			     error = $3,
			     -- Only a real process loss counts toward the escalation. A run that
			     -- never started is being handed back, not retried after a failure.
			     process_loss_retry_count = process_loss_retry_count + $4::int
			 WHERE id = $1
			   AND status IN ($5::heartbeat_run_status, $6::heartbeat_run_status)
			 RETURNING id`,
			[
				run.id,
				neverStarted ? HeartbeatRunStatus.Cancelled : HeartbeatRunStatus.Failed,
				error,
				neverStarted ? 0 : 1,
				HeartbeatRunStatus.Queued,
				HeartbeatRunStatus.Running,
			],
		);
		// The row went terminal between the scan and this write - its own driver got
		// there first, a container-death sweep claimed it, or an operator terminated
		// it. That writer observed the run; this pass only ever observed its absence
		// from an in-process registry, so their verdict stands and none of the repair
		// below is this pass's to do. Unguarded, the race replaced a specific cause
		// with the generic one and spent a strike on a run that had already reported
		// itself.
		if (reaped.rows.length === 0) continue;

		orphanCount++;

		// Task-less runs can't resolve a container here; the startup sweep is
		// their backstop.
		if (opts?.killProcesses && run.container_id) {
			await opts
				.killProcesses(run.container_id, run.id)
				.catch((e) => log.warn(`Failed to kill orphaned run ${run.id} processes:`, e));
		}

		await db.query(
			'UPDATE execution_locks SET released_at = now() WHERE member_id = $1 AND released_at IS NULL',
			[run.member_id],
		);

		await setAgentIdleIfNoActiveRuns(db, run.member_id, run.team_id, run.id, wsManager);

		broadcastRowChange(wsManager, wsRoom.team(run.team_id), 'heartbeat_runs', 'UPDATE', {
			id: run.id,
			member_id: run.member_id,
			task_id: run.task_id,
			project_id: run.project_id,
			status: neverStarted ? HeartbeatRunStatus.Cancelled : HeartbeatRunStatus.Failed,
			error,
		});

		// A run that never started is put back rather than retried: the original
		// wakeup returns to the queue for the dispatcher to pick up, exactly as
		// `JobManager.settleWakeupForRun` does for the capacity park's own give-up
		// path. Guarded on `claimed` so a wakeup already settled by another path is
		// not resurrected. With no wakeup to return (a run started by something
		// else) there is nothing to hand back, so fall through to the retry path
		// rather than dropping the work.
		const requeued = neverStarted && run.wakeup_id ? await requeueWakeup(db, run.wakeup_id) : false;
		if (requeued) continue;

		await retryOrEscalateLostRun(
			db,
			{
				runId: run.id,
				memberId: run.member_id,
				teamId: run.team_id,
				priorRetries: run.process_loss_retry_count,
			},
			tail.text,
		);
	}

	return orphanCount;
}

/**
 * A run was lost to infrastructure rather than to the agent: retry it, or give
 * up and ask for a human.
 *
 * Two callers, which is why it is here rather than inline. The orphan detector
 * reaches it when a run's host-side driver died, and `agent-runner` when the
 * container's output stream closed mid-run - a dropped transport, not a failing
 * agent. Both are "the run did not get a fair attempt", and both should cost a
 * bounded retry rather than the agent's turn and a failure ping.
 *
 * The previous failure's exit code and log tail ride along on the wakeup, so the
 * retried agent can see what happened to its last attempt instead of starting
 * blind. Past {@link MAX_RETRIES} it stops and files an approval: something is
 * wrong that retrying is not going to fix, and silently retrying forever would
 * hide it.
 */
export async function retryOrEscalateLostRun(
	db: Db,
	run: { runId: string; memberId: string; teamId: string; priorRetries: number },
	/** Log excerpt the caller has already read, to save reading it twice. */
	knownLogTail?: string,
): Promise<void> {
	if (run.priorRetries + 1 < MAX_RETRIES) {
		const failedRun = await db.query<{ exit_code: number | null }>(
			`SELECT exit_code FROM heartbeat_runs WHERE id = $1`,
			[run.runId],
		);
		// Read the excerpt from storage; this used to aggregate the run's whole
		// log (up to 10 MB) to keep its last 1000 characters, on a 30s cron.
		const tailText =
			knownLogTail ?? (await readRunLogTail(db, run.runId, ORPHAN_LOG_TAIL_CHARS)).text;

		await createWakeup(db, run.memberId, run.teamId, WakeupSource.Timer, {
			reason: 'orphan_retry',
			retry_count: run.priorRetries + 1,
			max_retries: MAX_RETRIES,
			previous_failure: {
				run_id: run.runId,
				exit_code: failedRun.rows[0]?.exit_code ?? null,
				log_tail: tailText.length > 0 ? tailText : null,
			},
		});
	} else {
		await db.query(
			`INSERT INTO approvals (team_id, type, payload)
				 VALUES ($1, $2::approval_type, $3::jsonb)`,
			[
				run.teamId,
				ApprovalType.Strategy,
				JSON.stringify({
					type: 'agent_error',
					member_id: run.memberId,
					message: `Agent has failed ${MAX_RETRIES} consecutive times. Manual intervention required.`,
				}),
			],
		);
	}
}

/**
 * Repair DB state stranded when a run's completion bookkeeping never landed
 * (process wedge, swallowed error, crash between the run going terminal and
 * `onAgentComplete`). The orphan detector above only covers runs still marked
 * `running`; this pass covers the inverse — the run row is already terminal
 * but the surrounding state (execution lock, agent runtime status, claimed
 * wakeup) still says the agent is busy, which silently blocks every future
 * dispatch for that agent. Each step is independent and idempotent.
 */
export async function healStaleRunState(db: Db, wsManager?: WebSocketManager): Promise<void> {
	const grace = String(STALE_STATE_GRACE_SECONDS);

	// Locks whose holder has no queued/running run anymore.
	const locks = await db.query<{ id: string; member_id: string; task_id: string }>(
		`UPDATE execution_locks el
		 SET released_at = now()
		 WHERE el.released_at IS NULL
		   AND el.locked_at < now() - ($1 || ' seconds')::interval
		   AND NOT EXISTS (
		     SELECT 1 FROM heartbeat_runs hr
		     WHERE hr.member_id = el.member_id AND hr.task_id = el.task_id
		       AND hr.status IN ($2::heartbeat_run_status, $3::heartbeat_run_status)
		   )
		 RETURNING el.id, el.member_id, el.task_id`,
		[grace, HeartbeatRunStatus.Queued, HeartbeatRunStatus.Running],
	);
	for (const lock of locks.rows) {
		log.warn(
			`Released stale execution lock ${lock.id} (member ${lock.member_id}, task ${lock.task_id}): no active run holds it`,
		);
	}

	// Agents stuck `active` with no queued/running run. setAgentIdleIfNoActiveRuns
	// re-checks, advances last_heartbeat_at, and broadcasts.
	const stuckAgents = await db.query<{ id: string; team_id: string }>(
		`SELECT ma.id, m.team_id
		 FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE ma.runtime_status = $4::agent_runtime_status
		   AND ma.updated_at < now() - ($1 || ' seconds')::interval
		   AND NOT EXISTS (
		     SELECT 1 FROM heartbeat_runs hr
		     WHERE hr.member_id = ma.id
		       AND hr.status IN ($2::heartbeat_run_status, $3::heartbeat_run_status)
		   )`,
		[grace, HeartbeatRunStatus.Queued, HeartbeatRunStatus.Running, AgentRuntimeStatus.Active],
	);
	for (const agent of stuckAgents.rows) {
		const reset = await setAgentIdleIfNoActiveRuns(
			db,
			agent.id,
			agent.team_id,
			undefined,
			wsManager,
		);
		if (reset) {
			log.warn(`Reset stuck-active agent ${agent.id} to idle: no active run exists`);
		}
	}

	// Claimed wakeups whose dispatch never resolved them. If the run they
	// dispatched reached a terminal state, mirror onAgentComplete; if no run
	// row ever landed, return them to the queue for a retry.
	const stuckWakeups = await db.query<{ id: string }>(
		`SELECT w.id FROM agent_wakeup_requests w
		 WHERE w.status = $1::wakeup_status
		   AND w.claimed_at < now() - ($2 || ' seconds')::interval
		   AND NOT EXISTS (
		     SELECT 1 FROM heartbeat_runs hr
		     WHERE hr.wakeup_id = w.id
		       AND hr.status IN ($3::heartbeat_run_status, $4::heartbeat_run_status)
		   )`,
		[WakeupStatus.Claimed, grace, HeartbeatRunStatus.Queued, HeartbeatRunStatus.Running],
	);
	for (const wakeup of stuckWakeups.rows) {
		const run = await db.query<{ status: HeartbeatRunStatus }>(
			`SELECT status FROM heartbeat_runs WHERE wakeup_id = $1 ORDER BY created_at DESC LIMIT 1`,
			[wakeup.id],
		);
		const runStatus = run.rows[0]?.status;
		if (runStatus) {
			const resolved =
				runStatus === HeartbeatRunStatus.Succeeded ? WakeupStatus.Completed : WakeupStatus.Failed;
			await db.query(
				`UPDATE agent_wakeup_requests SET status = $1::wakeup_status, completed_at = now() WHERE id = $2`,
				[resolved, wakeup.id],
			);
			log.warn(`Resolved stale claimed wakeup ${wakeup.id} as ${resolved} (run ${runStatus})`);
		} else {
			await db.query(
				`UPDATE agent_wakeup_requests SET status = $1::wakeup_status, claimed_at = NULL WHERE id = $2`,
				[WakeupStatus.Queued, wakeup.id],
			);
			log.warn(`Requeued stale claimed wakeup ${wakeup.id}: its run never materialized`);
		}
	}
}
