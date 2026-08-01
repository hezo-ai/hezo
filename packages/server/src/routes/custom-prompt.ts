import { AuthType, DocumentType } from '@hezo/shared';
import { Hono } from 'hono';
import { trackBackground } from '../lib/background';
import { resolveActorMemberId } from '../lib/resolve';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { enqueueTeamCoherenceReviewTask } from '../services/description-tasks';
import { getDocument, listRevisions, restoreRevision, upsertDocument } from '../services/documents';

const log = logger.child('custom-prompt');

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

	const authorMemberId = await resolveActorMemberId(db, auth, teamId);
	const existing = await getDocument(db, {
		type: DocumentType.TeamPreferences,
		teamId,
	});

	const doc = await upsertDocument(db, c.get('wsManager'), {
		scope: { type: DocumentType.TeamPreferences, teamId },
		content: body.content,
		changeSummary: body.change_summary,
		authorMemberId,
	});

	// The Custom Prompt reaches every agent's prompt, so a change warrants a team
	// coherence review — regardless of who made it (the admin here, or an agent via MCP).
	if ((existing?.content ?? '') !== body.content) {
		const summary = body.change_summary
			? `Project Custom Prompt updated: ${body.change_summary}`
			: 'The project Custom Prompt was updated.';
		trackBackground(
			enqueueTeamCoherenceReviewTask(db, teamId, 'custom_prompt_updated', {
				changeSummary: summary,
			}).catch((e) =>
				log.error('Failed to enqueue coherence review after Custom Prompt update:', e),
			),
		);
	}

	return ok(c, doc.row, existing ? 200 : 201);
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
