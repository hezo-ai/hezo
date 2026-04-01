import { Hono } from 'hono';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';

export const executionLocksRoutes = new Hono<Env>();

executionLocksRoutes.get('/companies/:companyId/issues/:issueId/lock', async (c) => {
	const db = c.get('db');
	const issueId = c.req.param('issueId');

	const result = await db.query(
		`SELECT el.id, el.issue_id, el.member_id, el.locked_at,
		        COALESCE(ma.title, m.display_name) AS member_name
		 FROM execution_locks el
		 JOIN members m ON m.id = el.member_id
		 LEFT JOIN member_agents ma ON ma.id = el.member_id
		 WHERE el.issue_id = $1 AND el.released_at IS NULL`,
		[issueId],
	);

	if (result.rows.length === 0) {
		return ok(c, null);
	}

	return ok(c, result.rows[0]);
});

executionLocksRoutes.post('/companies/:companyId/issues/:issueId/lock', async (c) => {
	const db = c.get('db');
	const issueId = c.req.param('issueId');

	const body = await c.req.json<{ member_id: string }>();
	if (!body.member_id) {
		return err(c, 'INVALID_REQUEST', 'member_id is required', 400);
	}

	const existing = await db.query(
		'SELECT id FROM execution_locks WHERE issue_id = $1 AND released_at IS NULL',
		[issueId],
	);

	if (existing.rows.length > 0) {
		return err(c, 'CONFLICT', 'Issue is already locked by another agent', 409);
	}

	const result = await db.query(
		`INSERT INTO execution_locks (issue_id, member_id)
		 VALUES ($1, $2)
		 RETURNING *`,
		[issueId, body.member_id],
	);

	return ok(c, result.rows[0], 201);
});

executionLocksRoutes.delete('/companies/:companyId/issues/:issueId/lock', async (c) => {
	const db = c.get('db');
	const issueId = c.req.param('issueId');

	await db.query(
		'UPDATE execution_locks SET released_at = now() WHERE issue_id = $1 AND released_at IS NULL',
		[issueId],
	);

	return ok(c, { released: true });
});
