import { AuthType, DocumentType } from '@hezo/shared';
import { Hono } from 'hono';
import { resolveActorMemberId } from '../lib/resolve';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { writeCustomPrompt } from '../services/custom-prompt';
import { getDocument, listRevisions, restoreRevision } from '../services/documents';

export const customPromptRoutes = new Hono<Env>();

customPromptRoutes.get('/projects/:projectId/custom-prompt', async (c) => {
	const teamId = c.get('teamId') as string;

	const doc = await getDocument(c.get('db'), {
		type: DocumentType.TeamPreferences,
		teamId,
	});
	return ok(c, doc);
});

customPromptRoutes.patch('/projects/:projectId/custom-prompt', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const auth = c.get('auth');
	const body = await c.req.json<{ content: string; change_summary?: string }>();

	if (body.content === undefined) {
		return err(c, 'INVALID_REQUEST', 'content is required', 400);
	}

	// Shared with the MCP tool so the role gate, the style guard and the coherence
	// review can never apply on one path and not the other.
	const result = await writeCustomPrompt(db, c.get('wsManager'), {
		teamId,
		content: body.content,
		changeSummary: body.change_summary,
		auth,
	});
	if (result.status === 'denied') return err(c, 'FORBIDDEN', result.error, 403);
	if (result.status === 'invalid') return err(c, 'INVALID_REQUEST', result.error, 400);

	return ok(c, result.row, result.existed ? 200 : 201);
});

customPromptRoutes.get('/projects/:projectId/custom-prompt/revisions', async (c) => {
	const teamId = c.get('teamId') as string;

	const doc = await getDocument(c.get('db'), {
		type: DocumentType.TeamPreferences,
		teamId,
	});
	if (!doc) return ok(c, []);

	const revisions = await listRevisions(c.get('db'), doc.id);
	return ok(c, revisions);
});

customPromptRoutes.post('/projects/:projectId/custom-prompt/restore', async (c) => {
	const teamId = c.get('teamId') as string;

	const auth = c.get('auth');
	if (auth.type === AuthType.Agent) {
		return err(c, 'FORBIDDEN', 'Only the admin can restore revisions', 403);
	}

	const db = c.get('db');
	const body = await c.req.json<{ revision_number: number }>();
	if (typeof body.revision_number !== 'number') {
		return err(c, 'INVALID_REQUEST', 'revision_number is required', 400);
	}

	const doc = await getDocument(db, {
		type: DocumentType.TeamPreferences,
		teamId,
	});
	if (!doc) return err(c, 'NOT_FOUND', 'Custom Prompt not found', 404);

	const restoredByMemberId = await resolveActorMemberId(db, auth, teamId);
	const restored = await restoreRevision(db, c.get('wsManager'), {
		documentId: doc.id,
		revisionNumber: body.revision_number,
		restoredByMemberId,
	});
	// 'archived' is unreachable here — only project docs are ever archived — but
	// the union makes that explicit rather than assumed.
	if (restored.status !== 'restored') return err(c, 'NOT_FOUND', 'Revision not found', 404);

	return ok(c, restored.row);
});
