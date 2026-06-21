import type { PGlite } from '@electric-sql/pglite';
import { HeartbeatRunStatus, wsRoom } from '@hezo/shared';
import { broadcastRowChange } from '../lib/broadcast';
import type { JobManager } from './job-manager';
import { recordRunTerminated } from './task-events';
import type { WebSocketManager } from './ws';

export interface TerminateRunDeps {
	db: PGlite;
	wsManager: WebSocketManager | undefined;
	jobManager: JobManager;
}

interface TerminateResult {
	terminated: boolean;
	taskId: string | null;
}

export async function terminateHeartbeatRun(
	deps: TerminateRunDeps,
	runId: string,
	reason: string,
	actorMemberId: string | null,
): Promise<TerminateResult> {
	const { db, wsManager, jobManager } = deps;

	const lookup = await db.query<{
		status: string;
		team_id: string;
		task_id: string | null;
		member_id: string;
	}>('SELECT status, team_id, task_id, member_id FROM heartbeat_runs WHERE id = $1', [runId]);
	const row = lookup.rows[0];
	if (!row) return { terminated: false, taskId: null };
	if (row.status !== HeartbeatRunStatus.Running && row.status !== HeartbeatRunStatus.Queued) {
		return { terminated: false, taskId: row.task_id };
	}

	const wasLive = jobManager.cancelLiveRun(runId);

	if (wasLive) {
		// finalizeAbort() inside runAgent will write status=cancelled, finished_at,
		// exit_code=-1 once the abort cascades. Backfill the reason now without
		// racing that write — its UPDATE uses COALESCE on error.
		await db.query('UPDATE heartbeat_runs SET error = COALESCE(error, $1) WHERE id = $2', [
			reason,
			runId,
		]);
	} else {
		// Queued (not yet dispatched) — finalize directly.
		await db.query(
			`UPDATE heartbeat_runs
			    SET status = $1::heartbeat_run_status,
			        started_at = COALESCE(started_at, now()),
			        finished_at = now(),
			        exit_code = COALESCE(exit_code, -1),
			        error = COALESCE(error, $2)
			  WHERE id = $3
			    AND status IN ($4::heartbeat_run_status, $5::heartbeat_run_status)`,
			[
				HeartbeatRunStatus.Cancelled,
				reason,
				runId,
				HeartbeatRunStatus.Queued,
				HeartbeatRunStatus.Running,
			],
		);
		broadcastRowChange(wsManager, wsRoom.team(row.team_id), 'heartbeat_runs', 'UPDATE', {
			id: runId,
			task_id: row.task_id,
			team_id: row.team_id,
			member_id: row.member_id,
			status: HeartbeatRunStatus.Cancelled,
		});
	}

	if (row.task_id) {
		// The run-terminated note is a secondary system comment; connected-agent
		// attribution is not threaded this deep (the primary action is attributed
		// at its source).
		await recordRunTerminated(
			db,
			row.team_id,
			row.task_id,
			runId,
			reason,
			actorMemberId,
			null,
			wsManager,
		);
	}

	return { terminated: true, taskId: row.task_id };
}

export async function terminateRunsForTask(
	deps: TerminateRunDeps,
	taskId: string,
	reason: string,
	actorMemberId: string | null,
): Promise<number> {
	const rows = await deps.db.query<{ id: string }>(
		`SELECT id FROM heartbeat_runs
		  WHERE task_id = $1
		    AND status IN ($2::heartbeat_run_status, $3::heartbeat_run_status)`,
		[taskId, HeartbeatRunStatus.Queued, HeartbeatRunStatus.Running],
	);
	let count = 0;
	for (const row of rows.rows) {
		const result = await terminateHeartbeatRun(deps, row.id, reason, actorMemberId);
		if (result.terminated) count++;
	}
	return count;
}
