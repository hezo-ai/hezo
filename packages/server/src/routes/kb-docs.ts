import { ApprovalType, AuthType, DocumentType } from '@hezo/shared';
import { Hono } from 'hono';
import { resolveActorMemberId } from '../lib/resolve';
import { err, ok } from '../lib/response';
import { toSlug } from '../lib/slug';
import type { Env } from '../lib/types';
import { requireCompanyAccess } from '../middleware/auth';
import {
	deleteDocument,
	getDocument,
	listDocuments,
	listRevisions,
	restoreRevision,
	upsertDocument,
} from '../services/documents';

export const kbDocsRoutes = new Hono<Env>();

kbDocsRoutes.get('/companies/:companyId/kb-docs', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const docs = await listDocuments(c.get('db'), {
		type: DocumentType.KbDoc,
		companyId: access.companyId,
	});
	return ok(c, docs);
});

kbDocsRoutes.get('/companies/:companyId/kb-docs/:slug', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const doc = await getDocument(c.get('db'), {
		type: DocumentType.KbDoc,
		companyId: access.companyId,
		slug: c.req.param('slug'),
	});
	if (!doc) return err(c, 'NOT_FOUND', 'KB document not found', 404);

	return ok(c, doc);
});

kbDocsRoutes.post('/companies/:companyId/kb-docs', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const auth = c.get('auth');
	const body = await c.req.json<{ title: string; content?: string; slug?: string }>();

	if (!body.title?.trim()) {
		return err(c, 'INVALID_REQUEST', 'title is required', 400);
	}

	const slug = body.slug?.trim() || `${toSlug(body.title)}.md`;

	const conflict = await getDocument(db, {
		type: DocumentType.KbDoc,
		companyId: access.companyId,
		slug,
	});
	if (conflict) {
		return err(c, 'CONFLICT', `KB document with slug '${slug}' already exists`, 409);
	}

	const authorMemberId = await resolveActorMemberId(db, auth, access.companyId);
	const doc = await upsertDocument(db, c.get('wsManager'), {
		scope: { type: DocumentType.KbDoc, companyId: access.companyId, slug },
		title: body.title.trim(),
		content: body.content ?? '',
		authorMemberId,
	});

	return ok(c, doc, 201);
});

kbDocsRoutes.patch('/companies/:companyId/kb-docs/:slug', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const slug = c.req.param('slug');
	const auth = c.get('auth');

	const existing = await getDocument(db, {
		type: DocumentType.KbDoc,
		companyId: access.companyId,
		slug,
	});
	if (!existing) return err(c, 'NOT_FOUND', 'KB document not found', 404);

	const body = await c.req.json<{
		title?: string;
		content?: string;
		change_summary?: string;
	}>();

	if (auth.type === AuthType.Agent) {
		await db.query(
			`INSERT INTO approvals (company_id, type, requested_by_member_id, payload)
			 VALUES ($1, $2::approval_type, $3, $4::jsonb)`,
			[
				access.companyId,
				ApprovalType.KbUpdate,
				auth.memberId,
				JSON.stringify({
					doc_id: existing.id,
					slug,
					title: body.title,
					content: body.content,
					change_summary: body.change_summary ?? '',
				}),
			],
		);
		return c.json({ data: { pending_approval: true, slug } }, 202);
	}

	if (body.title === undefined && body.content === undefined) {
		return ok(c, existing);
	}

	const authorMemberId = await resolveActorMemberId(db, auth, access.companyId);
	const doc = await upsertDocument(db, c.get('wsManager'), {
		scope: { type: DocumentType.KbDoc, companyId: access.companyId, slug },
		title: body.title?.trim(),
		content: body.content ?? existing.content,
		changeSummary: body.change_summary,
		authorMemberId,
	});

	return ok(c, doc);
});

kbDocsRoutes.delete('/companies/:companyId/kb-docs/:slug', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const removed = await deleteDocument(c.get('db'), c.get('wsManager'), {
		type: DocumentType.KbDoc,
		companyId: access.companyId,
		slug: c.req.param('slug'),
	});
	if (!removed) return err(c, 'NOT_FOUND', 'KB document not found', 404);

	return c.json({ data: null }, 200);
});

kbDocsRoutes.post('/companies/:companyId/kb-docs/:slug/restore', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const auth = c.get('auth');
	if (auth.type === AuthType.Agent) {
		return err(c, 'FORBIDDEN', 'Only board members can restore revisions', 403);
	}

	const db = c.get('db');
	const slug = c.req.param('slug');
	const body = await c.req.json<{ revision_number: number }>();
	if (typeof body.revision_number !== 'number') {
		return err(c, 'INVALID_REQUEST', 'revision_number is required', 400);
	}

	const doc = await getDocument(db, {
		type: DocumentType.KbDoc,
		companyId: access.companyId,
		slug,
	});
	if (!doc) return err(c, 'NOT_FOUND', 'KB document not found', 404);

	const restoredByMemberId = await resolveActorMemberId(db, auth, access.companyId);
	const restored = await restoreRevision(db, c.get('wsManager'), {
		documentId: doc.id,
		revisionNumber: body.revision_number,
		restoredByMemberId,
	});
	if (!restored) return err(c, 'NOT_FOUND', 'Revision not found', 404);

	return ok(c, restored);
});

kbDocsRoutes.get('/companies/:companyId/kb-docs/:slug/revisions', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const doc = await getDocument(c.get('db'), {
		type: DocumentType.KbDoc,
		companyId: access.companyId,
		slug: c.req.param('slug'),
	});
	if (!doc) return err(c, 'NOT_FOUND', 'KB document not found', 404);

	const revisions = await listRevisions(c.get('db'), doc.id);
	return ok(c, revisions);
});
