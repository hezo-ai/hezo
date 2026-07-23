import {
	AgentRuntimeStatus,
	ApprovalType,
	HeartbeatRunStatus,
	WakeupSource,
	WakeupStatus,
	wsRoom,
} from '@hezo/shared';
import type { Db } from '../db/database';
import { runLogTextSql } from '../db/run-log-chunks';
import { broadcastRowChange } from '../lib/broadcast';
import { logger } from '../logger';
import { setAgentIdleIfNoActiveRuns } from './agent-runtime-status';
import { createWakeup } from './wakeup';
import type { WebSocketManager } from './ws';

const log = logger.child('orphan-detector');

const MAX_RETRIES = 3;
const SAFETY_WINDOW_SECONDS = 30;
/** How long DB state may disagree with the absence of any active run before
 * the heal pass repairs it. Long enough to cover the dispatch window (status
 * flips active before the run row lands) and normal completion bookkeeping. */
export const STALE_STATE_GRACE_SECONDS = 120;

export interface DetectOrphansOpts {
	/**
	 * Best-effort reaper for the orphaned run's in-container process tree
	 * (`DockerClient.killRunProcesses`). A run row can outlive its host-side
	 * driver while the exec'd agent CLI keeps running in the container — when
	 * the detector declares the run orphaned, the tree must die with it.
	 */
	killProcesses?: (containerId: string, runId: string) => Promise<void>;
}

export async function detectOrphans(
	db: Db,
	liveRunIds: Set<string>,
	wsManager?: WebSocketManager,
	opts?: DetectOrphansOpts,
): Promise<number> {
	const orphans = await db.query<{
		id: string;
		member_id: string;
		team_id: string;
		task_id: string | null;
		project_id: string | null;
		container_id: string | null;
		process_loss_retry_count: number;
	}>(
		`SELECT hr.id, hr.member_id, hr.team_id, hr.task_id, hr.process_loss_retry_count,
		        (SELECT t.project_id FROM tasks t WHERE t.id = hr.task_id) AS project_id,
		        (SELECT p.container_id FROM projects p JOIN tasks t ON t.project_id = p.id
		         WHERE t.id = hr.task_id) AS container_id
		 FROM heartbeat_runs hr
		 WHERE hr.status = $1::heartbeat_run_status
		   AND hr.started_at < now() - ($2 || ' seconds')::interval`,
		[HeartbeatRunStatus.Running, String(SAFETY_WINDOW_SECONDS)],
	);

	let orphanCount = 0;

	for (const run of orphans.rows) {
		if (liveRunIds.has(run.id)) continue;

		orphanCount++;

		await db.query(
			`UPDATE heartbeat_runs
			 SET status = $2::heartbeat_run_status,
			     finished_at = now(),
			     error = 'Orphaned: process no longer running',
			     process_loss_retry_count = process_loss_retry_count + 1
			 WHERE id = $1`,
			[run.id, HeartbeatRunStatus.Failed],
		);

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
			status: HeartbeatRunStatus.Failed,
			error: 'Orphaned: process no longer running',
		});

		if (run.process_loss_retry_count + 1 < MAX_RETRIES) {
			const failedRun = await db.query<{
				exit_code: number | null;
				log_text: string | null;
			}>(
				`SELECT exit_code, ${runLogTextSql('heartbeat_runs.id')} AS log_text
				 FROM heartbeat_runs WHERE id = $1`,
				[run.id],
			);
			const fr = failedRun.rows[0];

			await createWakeup(db, run.member_id, run.team_id, WakeupSource.Timer, {
				reason: 'orphan_retry',
				retry_count: run.process_loss_retry_count + 1,
				max_retries: MAX_RETRIES,
				previous_failure: {
					run_id: run.id,
					exit_code: fr?.exit_code ?? null,
					log_tail: fr?.log_text?.slice(-1000) ?? null,
				},
			});
		} else {
			await db.query(
				`INSERT INTO approvals (team_id, type, payload)
				 VALUES ($1, $2::approval_type, $3::jsonb)`,
				[
					run.team_id,
					ApprovalType.Strategy,
					JSON.stringify({
						type: 'agent_error',
						member_id: run.member_id,
						message: `Agent has failed ${MAX_RETRIES} consecutive times. Manual intervention required.`,
					}),
				],
			);
		}
	}

	return orphanCount;
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
