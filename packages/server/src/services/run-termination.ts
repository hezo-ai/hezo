import {
	AgentAdminStatus,
	COACH_AGENT_SLUG,
	HeartbeatRunStatus,
	WakeupStatus,
	wsRoom,
} from '@hezo/shared';
import type { Db } from '../db/database';
import { broadcastRowChange } from '../lib/broadcast';
import type { JobManager } from './job-manager';
import { recordRunTerminated } from './task-events';
import type { WebSocketManager } from './ws';

export interface TerminateRunDeps {
	db: Db;
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
		project_id: string | null;
	}>(
		`SELECT hr.status, hr.team_id, hr.task_id, hr.member_id,
		        (SELECT t.project_id FROM tasks t WHERE t.id = hr.task_id) AS project_id
		   FROM heartbeat_runs hr WHERE hr.id = $1`,
		[runId],
	);
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
			project_id: row.project_id,
			member_id: row.member_id,
			status: HeartbeatRunStatus.Cancelled,
		});
	}

	if (row.task_id) {
		// The run-terminated note is a secondary system comment; API-key
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

/**
 * Cancel any pending Coach work on a task that has just been re-opened. The
 * Coach is an instance-level singleton woken when a task is marked `done`; once
 * the admin re-opens the task that review is moot, so retire its still-queued
 * wakeup(s) and terminate any queued/running Coach run on the task. Strictly
 * scoped to the Coach member, so the assignee's `task_reopened` wakeup and any
 * other agent's work on the task are untouched.
 */
export async function cancelCoachWorkForTask(
	deps: TerminateRunDeps,
	teamId: string,
	taskId: string,
	actorMemberId: string | null,
): Promise<void> {
	const { db, wsManager } = deps;

	const coach = await db.query<{ id: string }>(
		`SELECT id FROM member_agents
		  WHERE slug = $1 AND admin_status = $2::agent_admin_status
		  LIMIT 1`,
		[COACH_AGENT_SLUG, AgentAdminStatus.Enabled],
	);
	const coachId = coach.rows[0]?.id;
	if (!coachId) return;

	// Resolve the task's project so realtime invalidation scopes to it (the client
	// resolves agent_wakeup_requests strictly by project_id, never the team).
	const projectRow = await db.query<{ project_id: string }>(
		'SELECT project_id FROM tasks WHERE id = $1',
		[taskId],
	);
	const projectId = projectRow.rows[0]?.project_id ?? null;

	// Retire still-queued Coach wakeups for this task.
	const cancelled = await db.query<{ id: string }>(
		`UPDATE agent_wakeup_requests
		    SET status = $1::wakeup_status, completed_at = now()
		  WHERE member_id = $2
		    AND status = $3::wakeup_status
		    AND payload->>'task_id' = $4
		 RETURNING id`,
		[WakeupStatus.Cancelled, coachId, WakeupStatus.Queued, taskId],
	);
	for (const row of cancelled.rows) {
		broadcastRowChange(wsManager, wsRoom.team(teamId), 'agent_wakeup_requests', 'UPDATE', {
			id: row.id,
			team_id: teamId,
			task_id: taskId,
			project_id: projectId,
			member_id: coachId,
			status: WakeupStatus.Cancelled,
		});
	}

	// Terminate any queued/running Coach run already started for this task.
	const runs = await db.query<{ id: string }>(
		`SELECT id FROM heartbeat_runs
		  WHERE task_id = $1 AND member_id = $2
		    AND status IN ($3::heartbeat_run_status, $4::heartbeat_run_status)`,
		[taskId, coachId, HeartbeatRunStatus.Queued, HeartbeatRunStatus.Running],
	);
	for (const row of runs.rows) {
		await terminateHeartbeatRun(deps, row.id, 'Task re-opened', actorMemberId);
	}
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
