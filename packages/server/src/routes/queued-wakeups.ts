import { WakeupSource, WakeupStatus, wsRoom } from '@hezo/shared';
import { Hono } from 'hono';
import { broadcastChange } from '../lib/broadcast';
import { shouldDeferWakeupForBlockers } from '../lib/dependencies';
import { apiKeyIdFromAuth, resolveActorMemberId, resolveTaskId } from '../lib/resolve';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import {
	getBusyAgentIdsInProject,
	isContainerCapacityBlockedInDb,
	isTaskBusyInDb,
} from '../services/run-concurrency';
import { recordWakeupCancelled, resolveActorName } from '../services/task-events';
import { createWakeup } from '../services/wakeup';

const log = logger.child('routes');

export const queuedWakeupsRoutes = new Hono<Env>();

queuedWakeupsRoutes.get('/projects/:projectId/tasks/:taskId/queued-wakeups', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const taskId = await resolveTaskId(db, teamId, c.req.param('taskId'));
	if (!taskId) return err(c, 'NOT_FOUND', 'Task not found', 404);

	const result = await db.query<{
		id: string;
		member_id: string;
		member_name: string;
		source: string;
		created_at: string;
		coalesced_count: number;
		last_skipped_reason: string | null;
	}>(
		`SELECT w.id, w.member_id,
		        COALESCE(ma.title, m.display_name) AS member_name,
		        w.source, w.created_at, w.coalesced_count, w.last_skipped_reason
		 FROM agent_wakeup_requests w
		 JOIN members m ON m.id = w.member_id
		 LEFT JOIN member_agents ma ON ma.id = w.member_id
		 WHERE w.team_id = $1
		   AND w.status = $2::wakeup_status
		   AND w.payload->>'task_id' = $3::text
		 ORDER BY w.created_at ASC`,
		[teamId, WakeupStatus.Queued, taskId],
	);

	// Live run-now gating. Task busy state and the global run capacity are
	// shared by every wakeup on this task, so compute them once;
	// dependency-blocker state is per-wakeup because shouldDeferWakeupForBlockers
	// only gates certain wakeup sources.
	const projRow = await db.query<{ project_id: string }>(
		'SELECT project_id FROM tasks WHERE id = $1',
		[taskId],
	);
	const projectId = projRow.rows[0]?.project_id ?? null;

	let taskBusy = false;
	let instanceAtCapacity = false;
	if (await isTaskBusyInDb(db, taskId)) {
		taskBusy = true;
	} else if (projectId && (await isContainerCapacityBlockedInDb(db, c.get('docker'), projectId))) {
		instanceAtCapacity = true;
	}

	// agent_busy is per-agent (each wakeup has its own member), so it lives on
	// the wakeup rather than the shared dispatch state. One query for the whole
	// project; per-wakeup is a set membership check.
	const busyAgentIds = projectId
		? await getBusyAgentIdsInProject(db, projectId)
		: new Set<string>();

	const wakeups = await Promise.all(
		result.rows.map(async (w) => ({
			...w,
			agent_busy: busyAgentIds.has(w.member_id),
			run_now_blocked: (await shouldDeferWakeupForBlockers(db, w.source, taskId))
				? ('blocked_by_dependency' as const)
				: null,
		})),
	);

	return ok(c, {
		wakeups,
		dispatch: {
			task_busy: taskBusy,
			instance_at_capacity: instanceAtCapacity,
		},
	});
});

// Shared by both manual-dispatch handlers below; keys mirror DispatchNowResult.
const DISPATCH_CONFLICT_MESSAGES: Record<string, string> = {
	task_busy: 'This task already has a run in progress',
	instance_at_capacity:
		'Hezo is at its active-container limit; the run will start when a container goes idle',
	agent_busy: 'This agent is currently running on another task in this project',
	blocked: 'This task is blocked by an open dependency',
	not_queued: 'Wakeup is no longer queued and cannot be run',
};

queuedWakeupsRoutes.post(
	'/projects/:projectId/tasks/:taskId/queued-wakeups/:wakeupId/cancel',
	async (c) => {
		const teamId = c.get('teamId') as string;
		const db = c.get('db');
		const taskId = await resolveTaskId(db, teamId, c.req.param('taskId'));
		if (!taskId) return err(c, 'NOT_FOUND', 'Task not found', 404);
		const wakeupId = c.req.param('wakeupId');

		const lookup = await db.query<{ status: string; member_id: string }>(
			`SELECT status, member_id FROM agent_wakeup_requests
			 WHERE id = $1 AND team_id = $2 AND payload->>'task_id' = $3::text`,
			[wakeupId, teamId, taskId],
		);
		const row = lookup.rows[0];
		// 404 (not 403) for unknown / wrong-team / wrong-task to avoid leaking existence.
		if (!row) return err(c, 'NOT_FOUND', 'Queued wakeup not found', 404);
		if (row.status !== WakeupStatus.Queued) {
			return err(c, 'CONFLICT', `Wakeup is already ${row.status} and cannot be cancelled`, 409);
		}

		// Race-safe: the 5s dispatcher (processWakeups) may flip queued->claimed
		// between the lookup and here. The conditional WHERE guards against it.
		const updated = await db.query<{ id: string }>(
			`UPDATE agent_wakeup_requests
			    SET status = $1::wakeup_status, completed_at = now()
			  WHERE id = $2 AND status = $3::wakeup_status
			 RETURNING id`,
			[WakeupStatus.Cancelled, wakeupId, WakeupStatus.Queued],
		);
		if (updated.rows.length === 0) {
			return err(c, 'CONFLICT', 'Wakeup is no longer queued and cannot be cancelled', 409);
		}

		broadcastChange(c, wsRoom.team(teamId), 'agent_wakeup_requests', 'UPDATE', {
			id: wakeupId,
			team_id: teamId,
			task_id: taskId,
			project_id: c.get('projectId') as string,
			member_id: row.member_id,
			status: WakeupStatus.Cancelled,
		});

		const nameRes = await db.query<{ member_name: string }>(
			`SELECT COALESCE(ma.title, m.display_name) AS member_name
			 FROM members m LEFT JOIN member_agents ma ON ma.id = m.id
			 WHERE m.id = $1`,
			[row.member_id],
		);
		const agentName = nameRes.rows[0]?.member_name ?? 'an agent';
		const actorMemberId = await resolveActorMemberId(db, c.get('auth'), teamId);
		const actorApiKeyId = apiKeyIdFromAuth(c.get('auth'));
		try {
			await recordWakeupCancelled(
				db,
				teamId,
				taskId,
				wakeupId,
				agentName,
				actorMemberId,
				actorApiKeyId,
				c.get('wsManager'),
			);
		} catch (e) {
			log.error('Failed to record wakeup cancellation comment:', e);
		}

		return ok(c, { cancelled: true });
	},
);

queuedWakeupsRoutes.post(
	'/projects/:projectId/tasks/:taskId/queued-wakeups/:wakeupId/run-now',
	async (c) => {
		const teamId = c.get('teamId') as string;
		const db = c.get('db');
		const taskId = await resolveTaskId(db, teamId, c.req.param('taskId'));
		if (!taskId) return err(c, 'NOT_FOUND', 'Task not found', 404);
		const wakeupId = c.req.param('wakeupId');

		const lookup = await db.query<{ status: string; member_id: string }>(
			`SELECT status, member_id FROM agent_wakeup_requests
			 WHERE id = $1 AND team_id = $2 AND payload->>'task_id' = $3::text`,
			[wakeupId, teamId, taskId],
		);
		const row = lookup.rows[0];
		// 404 (not 403) for unknown / wrong-team / wrong-task to avoid leaking existence.
		if (!row) return err(c, 'NOT_FOUND', 'Queued wakeup not found', 404);
		if (row.status !== WakeupStatus.Queued) {
			return err(c, 'CONFLICT', `Wakeup is already ${row.status} and cannot be run`, 409);
		}

		// Stamp the triggering actor onto the wakeup payload so createHeartbeatRun
		// can fold it into the run comment's content — the run card itself shows
		// "started by Admin" instead of a separate system comment.
		const actorMemberId = await resolveActorMemberId(db, c.get('auth'), teamId);
		const actorName = await resolveActorName(db, actorMemberId);
		await db.query(
			`UPDATE agent_wakeup_requests
			 SET payload = payload || $1::jsonb
			 WHERE id = $2 AND status = $3::wakeup_status`,
			[
				JSON.stringify({ triggered_by: { member_id: actorMemberId, name: actorName } }),
				wakeupId,
				WakeupStatus.Queued,
			],
		);

		// Dispatch through the JobManager so the in-memory run guards and the
		// activateAgent launch path are reused (and the two run rules + blocker
		// policy re-checked race-safely at dispatch time).
		const result = await c.get('jobManager').dispatchWakeupNow(wakeupId);
		if (!result.dispatched) {
			if (result.reason === 'not_found') {
				return err(c, 'NOT_FOUND', 'Queued wakeup not found', 404);
			}
			return err(
				c,
				'CONFLICT',
				DISPATCH_CONFLICT_MESSAGES[result.reason] ?? 'Unable to start queued run',
				409,
			);
		}

		return ok(c, { dispatched: true });
	},
);

// Retry the agent that owned a previously-failed run on this task. Used by the
// Retry button on the `run_failed` system comment, where the user wants
// explicit control over re-running *this* task with *this* agent — the
// chained wakeup from the failure path doesn't guarantee either. Creates a
// fresh queued wakeup (or coalesces onto a pending one for the same
// agent+task) and dispatches it immediately through the same JobManager path
// as /run-now, so the run rules and dependency policy re-check race-safely.
queuedWakeupsRoutes.post('/projects/:projectId/tasks/:taskId/runs/:runId/retry', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const taskId = await resolveTaskId(db, teamId, c.req.param('taskId'));
	if (!taskId) return err(c, 'NOT_FOUND', 'Task not found', 404);
	const runId = c.req.param('runId');

	const runLookup = await db.query<{ member_id: string }>(
		`SELECT member_id FROM heartbeat_runs
			 WHERE id = $1 AND team_id = $2 AND task_id = $3`,
		[runId, teamId, taskId],
	);
	const runRow = runLookup.rows[0];
	// 404 (not 403) for unknown / wrong-team / wrong-task to avoid leaking existence.
	if (!runRow) return err(c, 'NOT_FOUND', 'Run not found', 404);

	const actorMemberId = await resolveActorMemberId(db, c.get('auth'), teamId);
	const actorName = await resolveActorName(db, actorMemberId);

	const wakeupId = await createWakeup(db, runRow.member_id, teamId, WakeupSource.OnDemand, {
		task_id: taskId,
		trigger: 'retry_failed_run',
		source_run_id: runId,
		triggered_by: { member_id: actorMemberId, name: actorName },
	});

	const result = await c.get('jobManager').dispatchWakeupNow(wakeupId);
	if (!result.dispatched) {
		if (result.reason === 'not_found') {
			return err(c, 'NOT_FOUND', 'Queued wakeup not found', 404);
		}
		return err(
			c,
			'CONFLICT',
			DISPATCH_CONFLICT_MESSAGES[result.reason] ?? 'Unable to start retry run',
			409,
		);
	}

	return ok(c, { dispatched: true });
});
