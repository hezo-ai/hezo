import { Hono } from 'hono';
import { broadcastChange } from '../lib/broadcast';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { requireCompanyAccess } from '../middleware/auth';

export const executionLocksRoutes = new Hono<Env>();

executionLocksRoutes.get('/companies/:companyId/issues/:issueId/lock', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const issueId = c.req.param('issueId');

	const issueCheck = await db.query('SELECT id FROM issues WHERE id = $1 AND company_id = $2', [
		issueId,
		companyId,
	]);
	if (issueCheck.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Issue not found', 404);
	}

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
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const issueId = c.req.param('issueId');

	const issueCheck = await db.query('SELECT id FROM issues WHERE id = $1 AND company_id = $2', [
		issueId,
		companyId,
	]);
	if (issueCheck.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Issue not found', 404);
	}

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

	broadcastChange(
		c,
		`company:${companyId}`,
		'execution_locks',
		'INSERT',
		result.rows[0] as Record<string, unknown>,
	);
	return ok(c, result.rows[0], 201);
});

executionLocksRoutes.delete('/companies/:companyId/issues/:issueId/lock', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const issueId = c.req.param('issueId');

	const issueCheck = await db.query('SELECT id FROM issues WHERE id = $1 AND company_id = $2', [
		issueId,
		companyId,
	]);
	if (issueCheck.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Issue not found', 404);
	}

	await db.query(
		'UPDATE execution_locks SET released_at = now() WHERE issue_id = $1 AND released_at IS NULL',
		[issueId],
	);

	broadcastChange(c, `company:${companyId}`, 'execution_locks', 'DELETE', { issue_id: issueId });
	return ok(c, { released: true });
});
