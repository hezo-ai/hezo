import { Hono } from 'hono';
import { resolveActorMemberId } from '../lib/resolve';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import {
	type CreateGoalInput,
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
	const runs = await listProgressUpdateRuns(c.get('db'), projectId);
	return ok(c, runs);
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
	if (result.dispatched) return ok(c, { dispatched: true });

	if (result.reason === 'no_due_goals') {
		return ok(c, { dispatched: false, reason: result.reason });
	}
	const message = PROGRESS_UPDATE_MESSAGES[result.reason];
	if (result.reason === 'no_project' || result.reason === 'no_captain') {
		return err(c, 'NOT_FOUND', message, 404);
	}
	return err(c, 'CONFLICT', message, 409);
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
	const goal = await getGoal(c.get('db'), projectId, goalId);
	if (!goal) return err(c, 'NOT_FOUND', 'Goal not found', 404);
	const runs = await listGoalRunActivity(c.get('db'), projectId, goalId);
	return ok(c, runs);
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
