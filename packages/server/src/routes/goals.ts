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
	listGoalCheckRuns,
	listGoalRunActivity,
	listGoals,
	type UpdateGoalInput,
	updateGoal,
} from '../services/goals';

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
	const runs = await listGoalCheckRuns(c.get('db'), projectId);
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

// The goal-check runs that did something for this goal (progress estimate, created tasks,
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
