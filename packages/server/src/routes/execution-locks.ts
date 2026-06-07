import { wsRoom } from '@hezo/shared';
import { Hono } from 'hono';
import { broadcastChange } from '../lib/broadcast';
import { resolveTaskId } from '../lib/resolve';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { acquireLock, listActiveLocks, releaseLocks } from '../repositories/execution-locks';

export const executionLocksRoutes = new Hono<Env>();

executionLocksRoutes.get('/projects/:projectId/tasks/:taskId/lock', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const taskId = await resolveTaskId(db, teamId, c.req.param('taskId'));
	if (!taskId) return err(c, 'NOT_FOUND', 'Task not found', 404);

	const locks = await listActiveLocks(db, taskId);
	return ok(c, { locks });
});

executionLocksRoutes.post('/projects/:projectId/tasks/:taskId/lock', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const taskId = await resolveTaskId(db, teamId, c.req.param('taskId'));
	if (!taskId) return err(c, 'NOT_FOUND', 'Task not found', 404);

	const body = await c.req.json<{ member_id: string }>();
	if (!body.member_id) {
		return err(c, 'INVALID_REQUEST', 'member_id is required', 400);
	}

	const lock = await acquireLock(db, taskId, body.member_id);
	if (!lock) {
		return err(c, 'CONFLICT', 'Member already holds a lock on this task', 409);
	}

	broadcastChange(
		c,
		wsRoom.team(teamId),
		'execution_locks',
		'INSERT',
		lock as Record<string, unknown>,
	);
	return ok(c, lock, 201);
});

executionLocksRoutes.delete('/projects/:projectId/tasks/:taskId/lock', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const taskId = await resolveTaskId(db, teamId, c.req.param('taskId'));
	if (!taskId) return err(c, 'NOT_FOUND', 'Task not found', 404);

	await releaseLocks(db, taskId);

	broadcastChange(c, wsRoom.team(teamId), 'execution_locks', 'DELETE', { task_id: taskId });
	return ok(c, { released: true });
});
