import { WakeupStatus, wsRoom } from '@hezo/shared';
import { Hono } from 'hono';
import { broadcastChange } from '../lib/broadcast';
import { buildMeta, parsePagination } from '../lib/pagination';
import { resolveActorMemberId } from '../lib/resolve';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import {
	type CreateGoalInput,
	countGoalRunActivity,
	countProgressUpdateRuns,
	createGoal,
	GoalError,
	getGoal,
	getGoalHistory,
	listGoalRunActivity,
	listGoals,
	listProgressUpdateRuns,
	type UpdateGoalInput,
	updateGoal,
} from '../services/goals';
import type { ProgressUpdateDispatchReason } from '../services/job-manager';
import { resolveActorName } from '../services/task-events';

export const goalsRoutes = new Hono<Env>();

function statusForGoalError(code: GoalError['code']): 400 | 403 | 404 {
	return code === 'NOT_FOUND' ? 404 : code === 'FORBIDDEN' ? 403 : 400;
}

goalsRoutes.get('/projects/:projectId/goals', async (c) => {
	const projectId = c.get('projectId') as string;
	const includeArchived = c.req.query('include_archived') === 'true';
	const goals = await listGoals(c.get('db'), projectId, { includeArchived });
	return ok(c, goals);
});

// Registered before /goals/:goalId so "runs" isn't captured as a goal id.
goalsRoutes.get('/projects/:projectId/goals/runs', async (c) => {
	const projectId = c.get('projectId') as string;
	const db = c.get('db');
	const { page, perPage, offset } = parsePagination(c);
	const total = await countProgressUpdateRuns(db, projectId);
	const runs = await listProgressUpdateRuns(db, projectId, { limit: perPage, offset });
	return c.json({ data: runs, meta: buildMeta(page, perPage, total) });
});

goalsRoutes.post('/projects/:projectId/goals', async (c) => {
	const teamId = c.get('teamId') as string;
	const projectId = c.get('projectId') as string;
	const db = c.get('db');

	const body = await c.req.json<CreateGoalInput>();
	body.project_id = projectId;
	const actorMemberId = await resolveActorMemberId(db, c.get('auth'), teamId);

	try {
		const goal = await createGoal(db, teamId, body, { actorMemberId }, c.get('wsManager'));
		return ok(c, goal, 201);
	} catch (e) {
		if (e instanceof GoalError) return err(c, e.code, e.message, statusForGoalError(e.code));
		throw e;
	}
});

const PROGRESS_UPDATE_MESSAGES: Record<ProgressUpdateDispatchReason, string> = {
	no_project: 'Project not found.',
	no_captain: 'This project has no Captain to run progress updates.',
	captain_disabled: 'The Captain is currently disabled.',
	no_due_goals: 'No goals are due for a progress update right now.',
	agent_busy: 'The Captain is already running in this project.',
	project_at_capacity: 'This project is at its concurrent-run limit.',
	container_down: 'The project container is not running yet.',
	over_budget: 'The Captain or project is over its budget.',
	launch_conflict: 'A progress-update run is already starting.',
};

// Manually run the Captain's progress-update ("Run now" on the Goals page). Reuses the scheduled
// logic: it assesses the goals currently due and refreshes the project progress summary. "Nothing
// due" is a valid no-op (200), not an error.
goalsRoutes.post('/projects/:projectId/goals/run-now', async (c) => {
	const teamId = c.get('teamId') as string;
	const projectId = c.get('projectId') as string;
	const db = c.get('db');

	const actorMemberId = await resolveActorMemberId(db, c.get('auth'), teamId);
	const triggeredBy = actorMemberId
		? { member_id: actorMemberId, name: await resolveActorName(db, actorMemberId) }
		: null;

	const result = await c.get('jobManager').dispatchProgressUpdateNow(projectId, triggeredBy);
	if ('dispatched' in result && result.dispatched) return ok(c, { dispatched: true });
	// A transient conflict (Captain busy, project at capacity, container down, launch
	// race) was queued instead of erroring — it runs when the Captain frees up.
	if ('queued' in result) return ok(c, { queued: true, wakeup_id: result.wakeupId });

	if (result.reason === 'no_due_goals') {
		return ok(c, { dispatched: false, reason: result.reason });
	}
	const message = PROGRESS_UPDATE_MESSAGES[result.reason];
	if (result.reason === 'no_project' || result.reason === 'no_captain') {
		return err(c, 'NOT_FOUND', message, 404);
	}
	return err(c, 'CONFLICT', message, 409);
});

// The single queued manual progress-update run for this project ("Run now" while the Captain was
// busy), if any. At most one exists (deduped by `createProgressUpdateWakeup`). Scheduled heartbeat
// progress checks have no `progress_update_now` trigger, so they are never surfaced here.
goalsRoutes.get('/projects/:projectId/goals/queued-run', async (c) => {
	const teamId = c.get('teamId') as string;
	const projectId = c.get('projectId') as string;
	const db = c.get('db');

	const r = await db.query<{
		id: string;
		created_at: string;
		triggered_by: { member_id: string; name: string } | null;
	}>(
		`SELECT id, created_at, payload->'triggered_by' AS triggered_by
		 FROM agent_wakeup_requests
		 WHERE team_id = $1
		   AND status = $2::wakeup_status
		   AND payload->>'trigger' = 'progress_update_now'
		   AND payload->>'project_id' = $3::text
		 ORDER BY created_at ASC
		 LIMIT 1`,
		[teamId, WakeupStatus.Queued, projectId],
	);
	return ok(c, { queued: r.rows[0] ?? null });
});

// Cancel the queued manual progress-update run. Only manually-initiated ("Run now") runs carry the
// `progress_update_now` trigger, so scheduled heartbeat checks can't be cancelled through here.
goalsRoutes.post('/projects/:projectId/goals/queued-run/:wakeupId/cancel', async (c) => {
	const teamId = c.get('teamId') as string;
	const projectId = c.get('projectId') as string;
	const db = c.get('db');
	const wakeupId = c.req.param('wakeupId');

	const lookup = await db.query<{ status: string; member_id: string }>(
		`SELECT status, member_id FROM agent_wakeup_requests
		 WHERE id = $1 AND team_id = $2
		   AND payload->>'trigger' = 'progress_update_now'
		   AND payload->>'project_id' = $3::text`,
		[wakeupId, teamId, projectId],
	);
	const row = lookup.rows[0];
	// 404 (not 403) for unknown / wrong-team / wrong-project to avoid leaking existence.
	if (!row) return err(c, 'NOT_FOUND', 'Queued progress update not found', 404);
	if (row.status !== WakeupStatus.Queued) {
		return err(c, 'CONFLICT', `Queued run is already ${row.status} and cannot be cancelled`, 409);
	}

	// Race-safe: the 5s dispatcher (processWakeups) may flip queued->claimed between the
	// lookup and here. The conditional WHERE guards against it.
	const updated = await db.query<{ id: string }>(
		`UPDATE agent_wakeup_requests
		    SET status = $1::wakeup_status, completed_at = now()
		  WHERE id = $2 AND status = $3::wakeup_status
		 RETURNING id`,
		[WakeupStatus.Cancelled, wakeupId, WakeupStatus.Queued],
	);
	if (updated.rows.length === 0) {
		return err(c, 'CONFLICT', 'Queued run is no longer queued and cannot be cancelled', 409);
	}

	// A progress-update wakeup is task-less, so there's no task thread to record a
	// cancellation system comment on (unlike task queued-wakeups). The queued row
	// disappearing from the Goals page is the feedback.
	broadcastChange(c, wsRoom.team(teamId), 'agent_wakeup_requests', 'UPDATE', {
		id: wakeupId,
		team_id: teamId,
		project_id: projectId,
		member_id: row.member_id,
		status: WakeupStatus.Cancelled,
	});

	return ok(c, { cancelled: true });
});

goalsRoutes.get('/projects/:projectId/goals/:goalId', async (c) => {
	const projectId = c.get('projectId') as string;
	const goal = await getGoal(c.get('db'), projectId, c.req.param('goalId'));
	if (!goal) return err(c, 'NOT_FOUND', 'Goal not found', 404);
	return ok(c, goal);
});

goalsRoutes.get('/projects/:projectId/goals/:goalId/history', async (c) => {
	const projectId = c.get('projectId') as string;
	const history = await getGoalHistory(c.get('db'), projectId, c.req.param('goalId'));
	if (history === null) return err(c, 'NOT_FOUND', 'Goal not found', 404);
	return ok(c, history);
});

// The progress-update runs that did something for this goal (progress estimate, created tasks,
// commented tasks) — shown at the bottom of the goal detail page.
goalsRoutes.get('/projects/:projectId/goals/:goalId/runs', async (c) => {
	const projectId = c.get('projectId') as string;
	const goalId = c.req.param('goalId');
	const db = c.get('db');
	const goal = await getGoal(db, projectId, goalId);
	if (!goal) return err(c, 'NOT_FOUND', 'Goal not found', 404);
	const { page, perPage, offset } = parsePagination(c);
	const total = await countGoalRunActivity(db, projectId, goalId);
	const runs = await listGoalRunActivity(db, projectId, goalId, { limit: perPage, offset });
	return c.json({ data: runs, meta: buildMeta(page, perPage, total) });
});

goalsRoutes.patch('/projects/:projectId/goals/:goalId', async (c) => {
	const teamId = c.get('teamId') as string;
	const projectId = c.get('projectId') as string;
	const db = c.get('db');

	// Ensure the goal belongs to this project before mutating by team id.
	const existing = await getGoal(db, projectId, c.req.param('goalId'));
	if (!existing) return err(c, 'NOT_FOUND', 'Goal not found', 404);

	const body = await c.req.json<UpdateGoalInput>();
	try {
		const goal = await updateGoal(db, teamId, existing.id, body, c.get('wsManager'));
		return ok(c, goal);
	} catch (e) {
		if (e instanceof GoalError) return err(c, e.code, e.message, statusForGoalError(e.code));
		throw e;
	}
});

// Archive (soft delete) — goals are never hard-deleted.
goalsRoutes.delete('/projects/:projectId/goals/:goalId', async (c) => {
	const teamId = c.get('teamId') as string;
	const projectId = c.get('projectId') as string;
	const db = c.get('db');

	const existing = await getGoal(db, projectId, c.req.param('goalId'));
	if (!existing) return err(c, 'NOT_FOUND', 'Goal not found', 404);

	try {
		const goal = await updateGoal(db, teamId, existing.id, { archived: true }, c.get('wsManager'));
		return ok(c, goal);
	} catch (e) {
		if (e instanceof GoalError) return err(c, e.code, e.message, statusForGoalError(e.code));
		throw e;
	}
});
