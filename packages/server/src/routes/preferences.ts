import { AuthType, wsRoom } from '@hezo/shared';
import { Hono } from 'hono';
import { broadcastChange } from '../lib/broadcast';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { requireCompanyAccess } from '../middleware/auth';

export const preferencesRoutes = new Hono<Env>();

preferencesRoutes.get('/companies/:companyId/preferences', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;

	const result = await db.query(
		`SELECT cp.*, COALESCE(ma.title, m.display_name) AS last_updated_by_name
		 FROM company_preferences cp
		 LEFT JOIN members m ON m.id = cp.last_updated_by_member_id
		 LEFT JOIN member_agents ma ON ma.id = cp.last_updated_by_member_id
		 WHERE cp.company_id = $1`,
		[companyId],
	);

	if (result.rows.length === 0) {
		return ok(c, null);
	}

	return ok(c, result.rows[0]);
});

preferencesRoutes.patch('/companies/:companyId/preferences', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const auth = c.get('auth');

	const body = await c.req.json<{
		content: string;
		change_summary?: string;
	}>();

	if (body.content === undefined) {
		return err(c, 'INVALID_REQUEST', 'content is required', 400);
	}

	const authorMemberId = auth.type === AuthType.Agent ? auth.memberId : null;

	const existing = await db.query<{ id: string; content: string }>(
		'SELECT id, content FROM company_preferences WHERE company_id = $1',
		[companyId],
	);

	if (existing.rows.length === 0) {
		const result = await db.query(
			`INSERT INTO company_preferences (company_id, content, last_updated_by_member_id)
			 VALUES ($1, $2, $3)
			 RETURNING *`,
			[companyId, body.content, authorMemberId],
		);
		broadcastChange(
			c,
			wsRoom.company(companyId),
			'company_preferences',
			'INSERT',
			result.rows[0] as Record<string, unknown>,
		);
		return ok(c, result.rows[0], 201);
	}

	const pref = existing.rows[0];

	const revResult = await db.query<{ max_rev: number }>(
		'SELECT COALESCE(MAX(revision_number), 0)::int AS max_rev FROM company_preference_revisions WHERE preference_id = $1',
		[pref.id],
	);
	const nextRev = revResult.rows[0].max_rev + 1;

	await db.query(
		`INSERT INTO company_preference_revisions (preference_id, revision_number, content, change_summary, author_member_id)
		 VALUES ($1, $2, $3, $4, $5)`,
		[pref.id, nextRev, pref.content, body.change_summary ?? '', authorMemberId],
	);

	const result = await db.query(
		`UPDATE company_preferences SET content = $1, last_updated_by_member_id = $2
		 WHERE company_id = $3
		 RETURNING *`,
		[body.content, authorMemberId, companyId],
	);

	broadcastChange(
		c,
		wsRoom.company(companyId),
		'company_preferences',
		'UPDATE',
		result.rows[0] as Record<string, unknown>,
	);
	return ok(c, result.rows[0]);
});

preferencesRoutes.get('/companies/:companyId/preferences/revisions', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;

	const pref = await db.query<{ id: string }>(
		'SELECT id FROM company_preferences WHERE company_id = $1',
		[companyId],
	);

	if (pref.rows.length === 0) {
		return ok(c, []);
	}

	const result = await db.query(
		`SELECT r.*, COALESCE(ma.title, m.display_name) AS author_name
		 FROM company_preference_revisions r
		 LEFT JOIN members m ON m.id = r.author_member_id
		 LEFT JOIN member_agents ma ON ma.id = r.author_member_id
		 WHERE r.preference_id = $1
		 ORDER BY r.revision_number DESC`,
		[pref.rows[0].id],
	);

	return ok(c, result.rows);
});
