import { AuthType, GoalStatus, type GoalStatus as GoalStatusType, wsRoom } from '@hezo/shared';
import { type Context, Hono } from 'hono';
import { broadcastChange } from '../lib/broadcast';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { requireCompanyAccess } from '../middleware/auth';
import { enqueueGoalReviewTask } from '../services/goal-tickets';

const log = logger.child('routes/goals');

export const goalsRoutes = new Hono<Env>();

function isGoalStatus(value: unknown): value is GoalStatusType {
	return typeof value === 'string' && (Object.values(GoalStatus) as string[]).includes(value);
}

async function requireBoardMemberId(
	c: Context<Env>,
	companyId: string,
): Promise<string | null | Response> {
	const auth = c.get('auth');
	if (auth.type !== AuthType.Board) {
		return c.json(
			{ error: { code: 'FORBIDDEN', message: 'Only board members can manage goals' } },
			403,
		);
	}
	if (auth.isSuperuser) return null;
	const db = c.get('db');
	const result = await db.query<{ id: string }>(
		`SELECT m.id FROM members m
		 JOIN member_users mu ON mu.id = m.id
		 WHERE mu.user_id = $1 AND m.company_id = $2`,
		[auth.userId, companyId],
	);
	return result.rows[0]?.id ?? null;
}

goalsRoutes.get('/companies/:companyId/goals', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;
	const db = c.get('db');
	const { companyId } = access;

	const result = await db.query(
		`SELECT g.*,
		        p.name AS project_name,
		        p.slug AS project_slug
		 FROM goals g
		 LEFT JOIN projects p ON p.id = g.project_id
		 WHERE g.company_id = $1
		 ORDER BY
		   CASE g.status
		     WHEN 'active'   THEN 0
		     WHEN 'achieved' THEN 1
		     WHEN 'archived' THEN 2
		   END,
		   g.created_at DESC`,
		[companyId],
	);
	return ok(c, result.rows);
});

goalsRoutes.get('/companies/:companyId/goals/:goalId', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;
	const db = c.get('db');
	const { companyId } = access;
	const goalId = c.req.param('goalId');

	const result = await db.query(
		`SELECT g.*,
		        p.name AS project_name,
		        p.slug AS project_slug
		 FROM goals g
		 LEFT JOIN projects p ON p.id = g.project_id
		 WHERE g.id = $1 AND g.company_id = $2`,
		[goalId, companyId],
	);
	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Goal not found', 404);
	}
	return ok(c, result.rows[0]);
});

goalsRoutes.post('/companies/:companyId/goals', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;
	const db = c.get('db');
	const { companyId } = access;

	const board = await requireBoardMemberId(c, companyId);
	if (board instanceof Response) return board;
	const createdByMemberId = board;

	const body = await c.req.json<{
		title: string;
		description?: string;
		project_id?: string | null;
	}>();

	if (!body.title?.trim()) {
		return err(c, 'INVALID_REQUEST', 'title is required', 400);
	}

	let projectId: string | null = null;
	if (body.project_id) {
		const projectCheck = await db.query(
			'SELECT 1 FROM projects WHERE id = $1 AND company_id = $2',
			[body.project_id, companyId],
		);
		if (projectCheck.rows.length === 0) {
			return err(c, 'INVALID_REQUEST', 'project_id does not belong to this company', 400);
		}
		projectId = body.project_id;
	}

	const insertResult = await db.query<Record<string, unknown>>(
		`INSERT INTO goals (company_id, project_id, title, description, created_by_member_id)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING *`,
		[companyId, projectId, body.title.trim(), body.description?.trim() ?? '', createdByMemberId],
	);
	const goal = insertResult.rows[0];

	broadcastChange(c, wsRoom.company(companyId), 'goals', 'INSERT', goal);

	try {
		await enqueueGoalReviewTask(db, companyId, goal.id as string, 'created', c.get('wsManager'));
	} catch (e) {
		log.error('Failed to enqueue goal review task (create):', e);
	}

	return ok(c, goal, 201);
});

goalsRoutes.patch('/companies/:companyId/goals/:goalId', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;
	const db = c.get('db');
	const { companyId } = access;
	const goalId = c.req.param('goalId');

	const board = await requireBoardMemberId(c, companyId);
	if (board instanceof Response) return board;

	const existingResult = await db.query<{
		id: string;
		title: string;
		description: string;
		project_id: string | null;
		status: GoalStatusType;
	}>(
		'SELECT id, title, description, project_id, status FROM goals WHERE id = $1 AND company_id = $2',
		[goalId, companyId],
	);
	const existing = existingResult.rows[0];
	if (!existing) return err(c, 'NOT_FOUND', 'Goal not found', 404);

	const body = await c.req.json<{
		title?: string;
		description?: string;
		project_id?: string | null;
		status?: string;
	}>();

	const sets: string[] = [];
	const params: unknown[] = [];
	let idx = 1;
	let contentChanged = false;

	if (body.title !== undefined) {
		const trimmed = body.title.trim();
		if (!trimmed) return err(c, 'INVALID_REQUEST', 'title cannot be empty', 400);
		if (trimmed !== existing.title) contentChanged = true;
		sets.push(`title = $${idx}`);
		params.push(trimmed);
		idx++;
	}
	if (body.description !== undefined) {
		const trimmed = body.description.trim();
		if (trimmed !== existing.description) contentChanged = true;
		sets.push(`description = $${idx}`);
		params.push(trimmed);
		idx++;
	}
	if (body.project_id !== undefined) {
		let nextProject: string | null = null;
		if (body.project_id) {
			const projectCheck = await db.query(
				'SELECT 1 FROM projects WHERE id = $1 AND company_id = $2',
				[body.project_id, companyId],
			);
			if (projectCheck.rows.length === 0) {
				return err(c, 'INVALID_REQUEST', 'project_id does not belong to this company', 400);
			}
			nextProject = body.project_id;
		}
		if (nextProject !== existing.project_id) contentChanged = true;
		sets.push(`project_id = $${idx}`);
		params.push(nextProject);
		idx++;
	}
	if (body.status !== undefined) {
		if (!isGoalStatus(body.status)) {
			return err(c, 'INVALID_REQUEST', 'invalid status', 400);
		}
		sets.push(`status = $${idx}::goal_status`);
		params.push(body.status);
		idx++;
	}

	if (sets.length === 0) {
		return ok(c, existing);
	}

	sets.push(`updated_at = now()`);
	params.push(goalId);
	const updateResult = await db.query<Record<string, unknown>>(
		`UPDATE goals SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
		params,
	);
	const goal = updateResult.rows[0];

	broadcastChange(c, wsRoom.company(companyId), 'goals', 'UPDATE', goal);

	if (contentChanged) {
		try {
			await enqueueGoalReviewTask(db, companyId, goalId, 'updated', c.get('wsManager'));
		} catch (e) {
			log.error('Failed to enqueue goal review task (update):', e);
		}
	}

	return ok(c, goal);
});

goalsRoutes.delete('/companies/:companyId/goals/:goalId', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;
	const db = c.get('db');
	const { companyId } = access;
	const goalId = c.req.param('goalId');

	const board = await requireBoardMemberId(c, companyId);
	if (board instanceof Response) return board;

	const result = await db.query<Record<string, unknown>>(
		`UPDATE goals SET status = 'archived'::goal_status, updated_at = now()
		 WHERE id = $1 AND company_id = $2
		 RETURNING *`,
		[goalId, companyId],
	);
	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Goal not found', 404);
	}
	broadcastChange(c, wsRoom.company(companyId), 'goals', 'UPDATE', result.rows[0]);
	return ok(c, result.rows[0]);
});
