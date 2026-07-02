import { DocumentType } from '@hezo/shared';
import { type Context, Hono } from 'hono';
import { resolveActorMemberId, resolveProjectId } from '../lib/resolve';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import {
	clearReviewComments,
	createReviewComment,
	deleteReviewComment,
	listReviewComments,
	StaleDocumentError,
	updateReviewComment,
} from '../services/document-review';
import { getDocument } from '../services/documents';

/**
 * Review comments on a project document (view-mode highlight annotations).
 * Version-scoped: any content change to the document wipes them (enforced in
 * services/documents.ts), so anchors are always valid for the current content.
 */
export const documentReviewRoutes = new Hono<Env>();

const BASE = '/projects/:projectId/docs/:filename/review-comments';

interface DocContext {
	projectId: string;
	documentId: string;
}

async function resolveDoc(c: Context<Env>): Promise<DocContext | Response> {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const filename = c.req.param('filename') ?? '';
	const projectId = await resolveProjectId(db, teamId, c.req.param('projectId') ?? '');
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);
	const doc = await getDocument(db, {
		type: DocumentType.ProjectDoc,
		teamId,
		projectId,
		slug: filename,
	});
	if (!doc) return err(c, 'NOT_FOUND', `Document '${filename}' not found`, 404);
	return { projectId, documentId: doc.id };
}

documentReviewRoutes.get(BASE, async (c) => {
	const resolved = await resolveDoc(c);
	if (resolved instanceof Response) return resolved;
	const comments = await listReviewComments(c.get('db'), resolved.documentId);
	return ok(c, comments);
});

documentReviewRoutes.post(BASE, async (c) => {
	const resolved = await resolveDoc(c);
	if (resolved instanceof Response) return resolved;
	const teamId = c.get('teamId') as string;
	const db = c.get('db');

	const body = await c.req.json<{
		quote?: string;
		occurrence?: number;
		comment?: string;
		doc_updated_at?: string;
	}>();
	if (!body.quote || typeof body.quote !== 'string') {
		return err(c, 'INVALID_REQUEST', 'quote is required', 400);
	}
	if (!body.comment || typeof body.comment !== 'string' || body.comment.trim() === '') {
		return err(c, 'INVALID_REQUEST', 'comment is required', 400);
	}
	const occurrence = body.occurrence ?? 0;
	if (typeof occurrence !== 'number' || !Number.isInteger(occurrence) || occurrence < 0) {
		return err(c, 'INVALID_REQUEST', 'occurrence must be a non-negative integer', 400);
	}

	const authorMemberId = await resolveActorMemberId(db, c.get('auth'), teamId);
	try {
		const row = await createReviewComment(db, c.get('wsManager'), {
			teamId,
			projectId: resolved.projectId,
			documentId: resolved.documentId,
			quote: body.quote,
			occurrence,
			comment: body.comment,
			authorMemberId,
			expectedDocUpdatedAt: body.doc_updated_at,
		});
		if (!row) return err(c, 'NOT_FOUND', 'Document not found', 404);
		return c.json({ data: row }, 201);
	} catch (e) {
		if (e instanceof StaleDocumentError) {
			return err(c, 'CONFLICT', 'Document has changed since it was loaded — reload it', 409);
		}
		throw e;
	}
});

documentReviewRoutes.patch(`${BASE}/:commentId`, async (c) => {
	const resolved = await resolveDoc(c);
	if (resolved instanceof Response) return resolved;

	const body = await c.req.json<{ comment?: string }>();
	if (!body.comment || typeof body.comment !== 'string' || body.comment.trim() === '') {
		return err(c, 'INVALID_REQUEST', 'comment is required', 400);
	}

	const row = await updateReviewComment(c.get('db'), c.get('wsManager'), {
		teamId: c.get('teamId') as string,
		projectId: resolved.projectId,
		documentId: resolved.documentId,
		commentId: c.req.param('commentId'),
		comment: body.comment,
	});
	if (!row) return err(c, 'NOT_FOUND', 'Review comment not found', 404);
	return ok(c, row);
});

documentReviewRoutes.delete(`${BASE}/:commentId`, async (c) => {
	const resolved = await resolveDoc(c);
	if (resolved instanceof Response) return resolved;

	const removed = await deleteReviewComment(c.get('db'), c.get('wsManager'), {
		teamId: c.get('teamId') as string,
		projectId: resolved.projectId,
		documentId: resolved.documentId,
		commentId: c.req.param('commentId'),
	});
	if (!removed) return err(c, 'NOT_FOUND', 'Review comment not found', 404);
	return c.json({ data: null }, 200);
});

documentReviewRoutes.delete(BASE, async (c) => {
	const resolved = await resolveDoc(c);
	if (resolved instanceof Response) return resolved;

	await clearReviewComments(c.get('db'), c.get('wsManager'), {
		teamId: c.get('teamId') as string,
		projectId: resolved.projectId,
		documentId: resolved.documentId,
	});
	return c.json({ data: null }, 200);
});
