import {
	AgentRuntimeStatus,
	ApprovalType,
	HeartbeatRunStatus,
	RunCancelReason,
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
import { recordRunAbandoned } from './task-events';
import { createWakeup, settleWakeupForRun } from './wakeup';
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
 * What was observed, in the operator's terms. True whatever happens next, which
 * is the whole point: it is written by the reap `UPDATE` before the work has
 * been settled, so it may not assert an outcome.
 *
 * The never-started verdict used to end "so it was returned to the queue" - a
 * claim composed before the handback was attempted and stamped on the row
 * whether or not the handback succeeded. Its other half named a "host process",
 * which is this server, not the container and not the operator's machine.
 * Neither told a reader anything they could act on.
 */
const ORPHAN_VERDICT: Record<OrphanArm, string> = {
	never_started: 'Never started: this run was queued but never began, so no work was done.',
	// Says what was observed rather than what was inferred. This pass performs no
	// process check - it finds a `running` row that no live run in this process
	// claims - and the old wording ("process no longer running") asserted one,
	// which read as a fact while being a guess. It was also the text every setup
	// failure ended up wearing, because those runs threw without recording
	// anything and this was the only writer left.
	orphaned:
		'Orphaned: nothing was driving this run any more, so no result was ever recorded. ' +
		'A restart, a crash or a wedged dispatch - not the agent failing.',
};

/**
 * What happened to the work, written once it is known.
 *
 * A table rather than a branch, so a new outcome is a compile error here until
 * someone writes the sentence for it. Every sentence names a state the reader
 * can see for themselves: the queue, the Inbox, the Retry button.
 */
const ORPHAN_OUTCOME_COPY: Record<HandbackOutcome, string> = {
	requeued: 'The work is back in the queue and will be picked up automatically.',
	replaced: 'A fresh run has been queued to pick this work back up.',
	escalated:
		'Hezo has stopped retrying this and asked for a human. There is a pending item in your Inbox.',
	abandoned:
		'Nothing was left to put back on the queue, so this will not restart on its own. ' +
		'Use Retry to run it again.',
};

/** The run's `error`, carrying the outcome and the actual cause where the log has one. */
function orphanErrorMessage(arm: OrphanArm, outcome: HandbackOutcome, logTail: string): string {
	const verdict = `${ORPHAN_VERDICT[arm]} ${ORPHAN_OUTCOME_COPY[outcome]}`;
	const excerpt = logTail.trim().slice(-ORPHAN_ERROR_TAIL_CHARS).trim();
	return excerpt ? `${verdict}\n\nLast log output:\n${excerpt}` : verdict;
}

/** Which of the two stranded shapes a reaped row was. */
type OrphanArm = 'never_started' | 'orphaned';

/**
 * What became of the work a reaped run was carrying.
 *
 * `abandoned` is the one outcome that leaves work owed with nothing carrying it,
 * which is why it is named rather than folded into `escalated`: it is what the
 * run row, the Retry affordance and the thread notice all key off.
 */
type HandbackOutcome = 'requeued' | 'replaced' | 'escalated' | 'abandoned';

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
		agent_slug: string | null;
	}>(
		`SELECT hr.id, hr.member_id, hr.team_id, hr.task_id, hr.wakeup_id,
		        hr.process_loss_retry_count, hr.status,
		        (SELECT ma.slug FROM member_agents ma WHERE ma.id = hr.member_id) AS agent_slug,
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
		const arm: OrphanArm = neverStarted ? 'never_started' : 'orphaned';
		const terminalStatus = neverStarted ? HeartbeatRunStatus.Cancelled : HeartbeatRunStatus.Failed;

		// Read once and use twice - the message below and, on the failure arm, the
		// retry wakeup's excerpt. This runs on a 30s cron, so a second read per
		// orphan is a cost with nothing to show for it.
		const tail = await readRunLogTail(db, run.id, ORPHAN_LOG_TAIL_CHARS);

		// Claim the row FIRST, with the verdict alone. The outcome sentence is
		// appended below, once the work has actually been settled. Writing both at
		// once is what let this row assert "returned to the queue" for a handback
		// that had not been attempted yet and could still fail - the defect a
		// stranded ask looked identical to a served one through. The row carries a
		// true statement at every instant, including if this process dies between
		// the two writes.
		const reaped = await db.query<{ id: string }>(
			`UPDATE heartbeat_runs
			 SET status = $2::heartbeat_run_status,
			     finished_at = now(),
			     error = $3,
			     -- Only a real process loss counts toward the escalation. A run that
			     -- never started is being handed back, not retried after a failure;
			     -- its own bounded ladder spends the budget below, where it also
			     -- reads it.
			     process_loss_retry_count = process_loss_retry_count + $4::int
			 WHERE id = $1
			   AND status IN ($5::heartbeat_run_status, $6::heartbeat_run_status)
			 RETURNING id`,
			[
				run.id,
				terminalStatus,
				ORPHAN_VERDICT[arm],
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

		const outcome = neverStarted
			? await handBackNeverStartedWork(db, run)
			: (await retryOrEscalateLostRun(
						db,
						{
							runId: run.id,
							memberId: run.member_id,
							teamId: run.team_id,
							taskId: run.task_id,
							priorRetries: run.process_loss_retry_count,
						},
						tail.text,
					)) === 'retried'
				? 'replaced'
				: 'escalated';

		// Now the outcome is known, and only now, the row can say what happened to
		// the work. Guarded on the status this pass just wrote, so a terminate or a
		// container sweep landing in between keeps its own more specific record.
		//
		// `cancel_reason` rides along on the same write. Only the never-started arm
		// sets one: the orphaned arm is `Failed`, and a failure's cause is its
		// error, not a cancel attribution.
		const error = orphanErrorMessage(arm, outcome, tail.text);
		await db.query(
			`UPDATE heartbeat_runs SET error = $1, cancel_reason = COALESCE($4, cancel_reason)
			 WHERE id = $2 AND status = $3::heartbeat_run_status`,
			[
				error,
				run.id,
				terminalStatus,
				neverStarted
					? outcome === 'abandoned'
						? RunCancelReason.Abandoned
						: RunCancelReason.HandedBack
					: null,
			],
		);

		// Broadcast after the second write, so an open run page receives the final
		// text rather than the provisional verdict.
		broadcastRowChange(wsManager, wsRoom.team(run.team_id), 'heartbeat_runs', 'UPDATE', {
			id: run.id,
			member_id: run.member_id,
			task_id: run.task_id,
			project_id: run.project_id,
			status: terminalStatus,
			error,
		});

		// The only outcome a reader has to do something about, so the only one worth
		// a row in the thread. Everything else either re-runs on its own or was
		// somebody's own decision to stop.
		if (outcome === 'abandoned' && run.task_id) {
			await recordRunAbandoned(
				db,
				run.team_id,
				run.task_id,
				run.id,
				run.agent_slug,
				wsManager,
			).catch((e) => log.error(`Failed to post abandoned-run notice for run ${run.id}:`, e));
		}

		log.info(
			`Reaped ${arm} run ${run.id} (member ${run.member_id}, task ${run.task_id ?? 'none'}): ${outcome}`,
		);
	}

	return orphanCount;
}

/**
 * Put back the work a run that never started was carrying.
 *
 * Split off the process-loss ladder deliberately. A never-started run spent no
 * strike (nothing ran, nothing was produced), so gating it on the strike budget
 * was the defect: `retryOrEscalateLostRun` reads `process_loss_retry_count` for
 * its ceiling, `createHeartbeatRun` inherits that count down an orphan-retry
 * lineage, and this arm never incremented it - so an inherited 2 turned every
 * later never-start into a permanent dead end that filed one approval, guarded
 * `NOT EXISTS` per member, and queued nothing ever again.
 *
 * Two rungs, in order:
 *
 * 1. **Hand the original wakeup back.** It already names the work, and it keeps
 *    its own `source` - which decides whether the dependency gate and the no-work
 *    backoff apply to it. Requires the payload to name a task, or the run to have
 *    had none: `createSyntheticOnDemandWakeup` writes an empty payload, so
 *    returning one of those to the queue produces a task-less nudge that
 *    `activateAgent` answers by picking some other task by priority, or by
 *    completing it as "nothing to do". That is not this run's work.
 * 2. **Mint one replacement naming the task**, carrying the original's source so
 *    a `mention` does not silently become a `timer` - the downgrade that put a
 *    teammate's direct ask behind the dependency gate it was exempt from. This
 *    rung is bounded, and unlike rung 1 it spends a strike, so the arm that reads
 *    the ceiling is now the arm that fills it.
 *
 * Past the ceiling the work is abandoned: an approval is filed and the run says
 * so. Rung 1 stays deliberately unbounded, as before - the wakeup is intact and
 * the dispatcher owns it, each lap leaves a visible cancelled row and a queued
 * agent in the task sidebar, and bounding it would need a counter carried on the
 * wakeup itself.
 */
async function handBackNeverStartedWork(
	db: Db,
	run: {
		id: string;
		member_id: string;
		team_id: string;
		task_id: string | null;
		wakeup_id: string | null;
		process_loss_retry_count: number;
	},
): Promise<HandbackOutcome> {
	const original = run.wakeup_id
		? (
				await db.query<{ source: WakeupSource; task_id: string | null }>(
					`SELECT source, payload->>'task_id' AS task_id
					 FROM agent_wakeup_requests WHERE id = $1`,
					[run.wakeup_id],
				)
			).rows[0]
		: undefined;

	// A wakeup that names no task is only worth handing back when the run had no
	// task either - a progress update, say, where the agent picks its own work.
	if (run.wakeup_id && (original?.task_id || !run.task_id)) {
		const settled = await settleWakeupForRun(db, run.wakeup_id, {
			kind: 'handback',
			reason: WakeupSkipReason.RunNeverStarted,
		});
		if (settled.kind === 'requeued') return 'requeued';
	}

	if (!run.task_id || run.process_loss_retry_count + 1 >= MAX_RETRIES) {
		await fileLostRunApproval(db, {
			runId: run.id,
			memberId: run.member_id,
			teamId: run.team_id,
			taskId: run.task_id,
		});
		return 'abandoned';
	}

	await db.query(
		'UPDATE heartbeat_runs SET process_loss_retry_count = process_loss_retry_count + 1 WHERE id = $1',
		[run.id],
	);
	await createWakeup(db, run.member_id, run.team_id, original?.source ?? WakeupSource.Timer, {
		reason: 'never_started_retry',
		task_id: run.task_id,
		// Named under `previous_run_id`, NOT `previous_failure.run_id`:
		// `RUN_LINEAGE_SOURCES` gives only the latter `inheritsLossBudget`, and a
		// replacement for a run that produced nothing must record where it came
		// from without inheriting a budget it never spent.
		previous_run_id: run.id,
	});
	return 'replaced';
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
	run: {
		runId: string;
		memberId: string;
		teamId: string;
		/** The task the lost run was working, so the retry returns to it. */
		taskId?: string | null;
		priorRetries: number;
	},
	/** Log excerpt the caller has already read, to save reading it twice. */
	knownLogTail?: string,
): Promise<'retried' | 'escalated'> {
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
			// Naming the task is what makes this a retry rather than a nudge. A
			// task-less wakeup coalesces onto the agent's queued heartbeat and
			// `activateAgent` then picks a task by its own ordering, so the retry
			// could land on different work than was lost - and `retry_of_run_id`
			// would record lineage across two unrelated tasks. It also brings the
			// pre-dispatch busy and capacity guards into play, since every one of
			// them is inside `if (wakeupTaskId)`.
			...(run.taskId ? { task_id: run.taskId } : {}),
			retry_count: run.priorRetries + 1,
			max_retries: MAX_RETRIES,
			previous_failure: {
				run_id: run.runId,
				exit_code: failedRun.rows[0]?.exit_code ?? null,
				log_tail: tailText.length > 0 ? tailText : null,
			},
		});
		return 'retried';
	}

	await fileLostRunApproval(
		db,
		{ runId: run.runId, memberId: run.memberId, teamId: run.teamId, taskId: run.taskId },
		knownLogTail,
	);
	return 'escalated';
}

/**
 * Record that an agent needs a human, once per stuck agent rather than once per
 * ceiling hit.
 *
 * Shared by both give-up paths - the process-loss ladder and the never-started
 * one - so the two cannot drift in what they leave a human to find.
 */
async function fileLostRunApproval(
	db: Db,
	run: { runId: string; memberId: string; teamId: string; taskId?: string | null },
	knownLogTail?: string,
): Promise<void> {
	// One record per stuck agent, not one per ceiling. A partial unique index
	// would be stronger, but this pass is serial in a single process and an
	// index needs a migration for a guard that is not racing anything.
	// The member id is bound twice on purpose: once as the uuid column and once
	// as the text `payload->>` compares against. One parameter in both places
	// leaves Postgres unable to deduce a single type for it.
	await db.query(
		`INSERT INTO approvals (team_id, type, requested_by_member_id, payload)
		 SELECT $1, $2::approval_type, $3::uuid, $5::jsonb
		 WHERE NOT EXISTS (
		   SELECT 1 FROM approvals
		   WHERE team_id = $1 AND type = $2::approval_type AND status = 'pending'
		     AND payload->>'type' = 'agent_error'
		     AND payload->>'member_id' = $4::text
		 )`,
		[
			run.teamId,
			ApprovalType.Strategy,
			run.memberId,
			run.memberId,
			JSON.stringify({
				type: 'agent_error',
				member_id: run.memberId,
				// Named so the approval can be read back to the run that produced
				// it; without these the record said an agent had failed and gave a
				// human nowhere to look.
				run_id: run.runId,
				task_id: run.taskId ?? null,
				last_error: knownLogTail?.trim().slice(-ORPHAN_LOG_TAIL_CHARS) || null,
				message: `Agent has failed ${MAX_RETRIES} consecutive times. Manual intervention required.`,
			}),
		],
	);
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
