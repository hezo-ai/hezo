import { wsRoom } from '@hezo/shared';
import { Hono } from 'hono';
import { broadcastChange } from '../lib/broadcast';
import { resolveTaskId } from '../lib/resolve';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';

export const executionLocksRoutes = new Hono<Env>();

executionLocksRoutes.get('/teams/:teamId/tasks/:taskId/lock', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const taskId = await resolveTaskId(db, teamId, c.req.param('taskId'));
	if (!taskId) return err(c, 'NOT_FOUND', 'Task not found', 404);

	const result = await db.query(
		`SELECT el.id, el.task_id, el.member_id, el.lock_type, el.locked_at,
		        COALESCE(ma.title, m.display_name) AS member_name
		 FROM execution_locks el
		 JOIN members m ON m.id = el.member_id
		 LEFT JOIN member_agents ma ON ma.id = el.member_id
		 WHERE el.task_id = $1 AND el.released_at IS NULL`,
		[taskId],
	);

	return ok(c, { locks: result.rows });
});

executionLocksRoutes.post('/teams/:teamId/tasks/:taskId/lock', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const taskId = await resolveTaskId(db, teamId, c.req.param('taskId'));
	if (!taskId) return err(c, 'NOT_FOUND', 'Task not found', 404);

	const body = await c.req.json<{ member_id: string }>();
	if (!body.member_id) {
		return err(c, 'INVALID_REQUEST', 'member_id is required', 400);
	}

	const result = await db.query(
		`INSERT INTO execution_locks (task_id, member_id, lock_type)
		 SELECT $1, $2, 'read'
		 WHERE NOT EXISTS (
		   SELECT 1 FROM execution_locks
		   WHERE task_id = $1 AND member_id = $2 AND released_at IS NULL
		 )
		 RETURNING *`,
		[taskId, body.member_id],
	);

	if (result.rows.length === 0) {
		return err(c, 'CONFLICT', 'Member already holds a lock on this task', 409);
	}

	broadcastChange(
		c,
		wsRoom.team(teamId),
		'execution_locks',
		'INSERT',
		result.rows[0] as Record<string, unknown>,
	);
	return ok(c, result.rows[0], 201);
});

executionLocksRoutes.delete('/teams/:teamId/tasks/:taskId/lock', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const taskId = await resolveTaskId(db, teamId, c.req.param('taskId'));
	if (!taskId) return err(c, 'NOT_FOUND', 'Task not found', 404);

	await db.query(
		'UPDATE execution_locks SET released_at = now() WHERE task_id = $1 AND released_at IS NULL',
		[taskId],
	);

	broadcastChange(c, wsRoom.team(teamId), 'execution_locks', 'DELETE', { task_id: taskId });
	return ok(c, { released: true });
});
