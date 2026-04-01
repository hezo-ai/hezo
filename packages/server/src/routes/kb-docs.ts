import { ApprovalType, AuthType } from '@hezo/shared';
import { Hono } from 'hono';
import { broadcastChange } from '../lib/broadcast';
import { err, ok } from '../lib/response';
import { toSlug } from '../lib/slug';
import type { Env } from '../lib/types';
import { requireCompanyAccess } from '../middleware/auth';

export const kbDocsRoutes = new Hono<Env>();

kbDocsRoutes.get('/companies/:companyId/kb-docs', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;

	const result = await db.query(
		`SELECT kd.id, kd.company_id, kd.title, kd.slug, kd.content,
		        kd.last_updated_by_member_id, kd.created_at, kd.updated_at,
		        COALESCE(ma.title, m.display_name) AS last_updated_by_name
		 FROM kb_docs kd
		 LEFT JOIN members m ON m.id = kd.last_updated_by_member_id
		 LEFT JOIN member_agents ma ON ma.id = kd.last_updated_by_member_id
		 WHERE kd.company_id = $1
		 ORDER BY kd.title ASC`,
		[companyId],
	);

	return ok(c, result.rows);
});

kbDocsRoutes.get('/companies/:companyId/kb-docs/:slug', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const slug = c.req.param('slug');

	const result = await db.query(
		`SELECT kd.*, COALESCE(ma.title, m.display_name) AS last_updated_by_name
		 FROM kb_docs kd
		 LEFT JOIN members m ON m.id = kd.last_updated_by_member_id
		 LEFT JOIN member_agents ma ON ma.id = kd.last_updated_by_member_id
		 WHERE kd.company_id = $1 AND kd.slug = $2`,
		[companyId, slug],
	);

	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'KB document not found', 404);
	}

	return ok(c, result.rows[0]);
});

kbDocsRoutes.post('/companies/:companyId/kb-docs', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const auth = c.get('auth');

	const body = await c.req.json<{
		title: string;
		content?: string;
		slug?: string;
	}>();

	if (!body.title?.trim()) {
		return err(c, 'INVALID_REQUEST', 'title is required', 400);
	}

	const slug = body.slug?.trim() || toSlug(body.title);
	const authorMemberId = auth.type === AuthType.Agent ? auth.memberId : null;

	const result = await db.query(
		`INSERT INTO kb_docs (company_id, title, slug, content, last_updated_by_member_id)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING *`,
		[companyId, body.title.trim(), slug, body.content ?? '', authorMemberId],
	);

	broadcastChange(
		c,
		`company:${companyId}`,
		'kb_docs',
		'INSERT',
		result.rows[0] as Record<string, unknown>,
	);
	return ok(c, result.rows[0], 201);
});

kbDocsRoutes.patch('/companies/:companyId/kb-docs/:slug', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const slug = c.req.param('slug');
	const auth = c.get('auth');

	const existing = await db.query<{
		id: string;
		content: string;
	}>('SELECT id, content FROM kb_docs WHERE company_id = $1 AND slug = $2', [companyId, slug]);

	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'KB document not found', 404);
	}

	const doc = existing.rows[0];
	const body = await c.req.json<{
		title?: string;
		content?: string;
		change_summary?: string;
	}>();

	const authorMemberId = auth.type === AuthType.Agent ? auth.memberId : null;

	if (auth.type === AuthType.Agent) {
		await db.query(
			`INSERT INTO approvals (company_id, type, requested_by_member_id, payload)
			 VALUES ($1, $2::approval_type, $3, $4::jsonb)`,
			[
				companyId,
				ApprovalType.KbUpdate,
				auth.memberId,
				JSON.stringify({
					doc_id: doc.id,
					slug,
					title: body.title,
					content: body.content,
					change_summary: body.change_summary ?? '',
				}),
			],
		);
		return c.json({ data: { pending_approval: true, slug } }, 202);
	}

	if (body.content !== undefined) {
		const revResult = await db.query<{ max_rev: number }>(
			'SELECT COALESCE(MAX(revision_number), 0)::int AS max_rev FROM kb_doc_revisions WHERE doc_id = $1',
			[doc.id],
		);
		const nextRev = revResult.rows[0].max_rev + 1;

		await db.query(
			`INSERT INTO kb_doc_revisions (doc_id, revision_number, content, change_summary, author_member_id)
			 VALUES ($1, $2, $3, $4, $5)`,
			[doc.id, nextRev, doc.content, body.change_summary ?? '', authorMemberId],
		);
	}

	const sets: string[] = [];
	const params: unknown[] = [];
	let idx = 1;

	if (body.title?.trim() !== undefined) {
		sets.push(`title = $${idx}`);
		params.push(body.title.trim());
		idx++;
	}
	if (body.content !== undefined) {
		sets.push(`content = $${idx}`);
		params.push(body.content);
		idx++;
	}

	sets.push(`last_updated_by_member_id = $${idx}`);
	params.push(authorMemberId);
	idx++;

	if (sets.length === 0) {
		return ok(c, doc);
	}

	params.push(doc.id);
	const result = await db.query(
		`UPDATE kb_docs SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
		params,
	);

	broadcastChange(
		c,
		`company:${companyId}`,
		'kb_docs',
		'UPDATE',
		result.rows[0] as Record<string, unknown>,
	);
	return ok(c, result.rows[0]);
});

kbDocsRoutes.delete('/companies/:companyId/kb-docs/:slug', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const slug = c.req.param('slug');

	const existing = await db.query<{ id: string }>(
		'SELECT id FROM kb_docs WHERE company_id = $1 AND slug = $2',
		[companyId, slug],
	);

	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'KB document not found', 404);
	}

	await db.query('DELETE FROM kb_docs WHERE company_id = $1 AND slug = $2', [companyId, slug]);
	broadcastChange(c, `company:${companyId}`, 'kb_docs', 'DELETE', {
		id: existing.rows[0].id,
		slug,
	});
	return c.json({ data: null }, 200);
});

kbDocsRoutes.get('/companies/:companyId/kb-docs/:slug/revisions', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const slug = c.req.param('slug');

	const doc = await db.query<{ id: string }>(
		'SELECT id FROM kb_docs WHERE company_id = $1 AND slug = $2',
		[companyId, slug],
	);

	if (doc.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'KB document not found', 404);
	}

	const result = await db.query(
		`SELECT r.*, COALESCE(ma.title, m.display_name) AS author_name
		 FROM kb_doc_revisions r
		 LEFT JOIN members m ON m.id = r.author_member_id
		 LEFT JOIN member_agents ma ON ma.id = r.author_member_id
		 WHERE r.doc_id = $1
		 ORDER BY r.revision_number DESC`,
		[doc.rows[0].id],
	);

	return ok(c, result.rows);
});
