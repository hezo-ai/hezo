import { AuthType, DocumentType } from '@hezo/shared';
import { Hono } from 'hono';
import { resolveActorMemberId } from '../lib/resolve';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { requireCompanyAccess } from '../middleware/auth';
import { getDocument, listRevisions, restoreRevision, upsertDocument } from '../services/documents';

export const preferencesRoutes = new Hono<Env>();

preferencesRoutes.get('/companies/:companyId/preferences', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const doc = await getDocument(c.get('db'), {
		type: DocumentType.CompanyPreferences,
		companyId: access.companyId,
	});
	return ok(c, doc);
});

preferencesRoutes.patch('/companies/:companyId/preferences', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const auth = c.get('auth');
	const body = await c.req.json<{ content: string; change_summary?: string }>();

	if (body.content === undefined) {
		return err(c, 'INVALID_REQUEST', 'content is required', 400);
	}

	const authorMemberId = await resolveActorMemberId(db, auth, access.companyId);
	const existing = await getDocument(db, {
		type: DocumentType.CompanyPreferences,
		companyId: access.companyId,
	});

	const doc = await upsertDocument(db, c.get('wsManager'), {
		scope: { type: DocumentType.CompanyPreferences, companyId: access.companyId },
		content: body.content,
		changeSummary: body.change_summary,
		authorMemberId,
	});

	return ok(c, doc, existing ? 200 : 201);
});

preferencesRoutes.get('/companies/:companyId/preferences/revisions', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const doc = await getDocument(c.get('db'), {
		type: DocumentType.CompanyPreferences,
		companyId: access.companyId,
	});
	if (!doc) return ok(c, []);

	const revisions = await listRevisions(c.get('db'), doc.id);
	return ok(c, revisions);
});

preferencesRoutes.post('/companies/:companyId/preferences/restore', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const auth = c.get('auth');
	if (auth.type === AuthType.Agent) {
		return err(c, 'FORBIDDEN', 'Only board members can restore revisions', 403);
	}

	const db = c.get('db');
	const body = await c.req.json<{ revision_number: number }>();
	if (typeof body.revision_number !== 'number') {
		return err(c, 'INVALID_REQUEST', 'revision_number is required', 400);
	}

	const doc = await getDocument(db, {
		type: DocumentType.CompanyPreferences,
		companyId: access.companyId,
	});
	if (!doc) return err(c, 'NOT_FOUND', 'Preferences not found', 404);

	const restoredByMemberId = await resolveActorMemberId(db, auth, access.companyId);
	const restored = await restoreRevision(db, c.get('wsManager'), {
		documentId: doc.id,
		revisionNumber: body.revision_number,
		restoredByMemberId,
	});
	if (!restored) return err(c, 'NOT_FOUND', 'Revision not found', 404);

	return ok(c, restored);
});
