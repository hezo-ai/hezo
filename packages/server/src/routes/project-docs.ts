import {
	ApprovalType,
	AuthType,
	CHAT_MEMORY_SLUG,
	DEFAULT_TEAM_ID,
	DocumentType,
	isMarkdownDocSlug,
	repoNameFromIdentifier,
} from '@hezo/shared';
import { Hono } from 'hono';
import { resolveAgentsMdPath } from '../lib/docs';
import { actorTypeFromAuth, resolveActorMemberId, resolveProjectId } from '../lib/resolve';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { broadcastApprovalChange } from '../services/approval-broadcast';
import {
	deleteDocument,
	getDocument,
	listDocuments,
	listRevisions,
	restoreRevision,
	upsertDocument,
} from '../services/documents';

export const projectDocsRoutes = new Hono<Env>();

projectDocsRoutes.get('/projects/:projectId/docs', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const projectId = await resolveProjectId(db, teamId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const docs = await listDocuments(db, {
		type: DocumentType.ProjectDoc,
		teamId: teamId,
		projectId,
	});

	return ok(
		c,
		docs.map((d) => ({ id: d.id, filename: d.slug, updated_at: d.updated_at })),
	);
});

projectDocsRoutes.get('/projects/:projectId/docs/:filename', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const filename = c.req.param('filename');
	const projectId = await resolveProjectId(db, teamId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const doc = await getDocument(db, {
		type: DocumentType.ProjectDoc,
		teamId: teamId,
		projectId,
		slug: filename,
	});
	if (!doc) return err(c, 'NOT_FOUND', `Document '${filename}' not found`, 404);

	return ok(c, {
		id: doc.id,
		filename: doc.slug,
		content: doc.content,
		updated_at: doc.updated_at,
	});
});

projectDocsRoutes.put('/projects/:projectId/docs/:filename', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const filename = c.req.param('filename');
	const auth = c.get('auth');
	const projectId = await resolveProjectId(db, teamId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	if (!isMarkdownDocSlug(filename)) {
		return err(c, 'INVALID_REQUEST', 'Project docs must be markdown (.md)', 400);
	}

	const body = await c.req.json<{ content: string; change_summary?: string }>();
	if (body.content === undefined) {
		return err(c, 'INVALID_REQUEST', 'content is required', 400);
	}

	if (filename === 'prd.md' && auth.type === AuthType.Agent) {
		const approvalResult = await db.query<Record<string, unknown>>(
			`INSERT INTO approvals (team_id, type, requested_by_member_id, payload)
			 VALUES ($1, $2::approval_type, $3, $4::jsonb)
			 RETURNING *`,
			[
				teamId,
				ApprovalType.Strategy,
				auth.memberId,
				JSON.stringify({
					action: 'update_prd',
					filename,
					content: body.content,
					project_id: projectId,
				}),
			],
		);
		const row = approvalResult.rows[0];
		if (row) {
			broadcastApprovalChange(c.get('wsManager'), teamId, 'INSERT', row);
		}
		return c.json({ data: { pending_approval: true, filename } }, 202);
	}

	const memberId = await resolveActorMemberId(db, auth, teamId);

	const doc = await upsertDocument(db, c.get('wsManager'), {
		scope: {
			type: DocumentType.ProjectDoc,
			teamId: teamId,
			projectId,
			slug: filename,
		},
		content: body.content,
		changeSummary: body.change_summary,
		authorMemberId: memberId,
		audit: { events: c.get('events'), actorType: actorTypeFromAuth(auth) },
	});

	return ok(c, {
		id: doc.id,
		filename: doc.slug,
		content: doc.content,
		updated_at: doc.updated_at,
	});
});

projectDocsRoutes.delete('/projects/:projectId/docs/:filename', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const filename = c.req.param('filename');
	const projectId = await resolveProjectId(db, teamId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	// The chatbox memory doc lives only in the HQ project (the default team) and
	// is permanent — block deletion by any principal.
	if (teamId === DEFAULT_TEAM_ID && filename === CHAT_MEMORY_SLUG) {
		return err(c, 'FORBIDDEN', `'${filename}' is the chatbox memory and cannot be deleted`, 403);
	}

	const actorMemberId = await resolveActorMemberId(db, c.get('auth'), teamId);
	const removed = await deleteDocument(
		db,
		c.get('wsManager'),
		{
			type: DocumentType.ProjectDoc,
			teamId: teamId,
			projectId,
			slug: filename,
		},
		{ events: c.get('events'), actorType: actorTypeFromAuth(c.get('auth')), actorMemberId },
	);
	if (!removed) return err(c, 'NOT_FOUND', `Document '${filename}' not found`, 404);

	return c.json({ data: null }, 200);
});

projectDocsRoutes.get('/projects/:projectId/docs/:filename/revisions', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const filename = c.req.param('filename');
	const projectId = await resolveProjectId(db, teamId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const doc = await getDocument(db, {
		type: DocumentType.ProjectDoc,
		teamId: teamId,
		projectId,
		slug: filename,
	});
	if (!doc) return err(c, 'NOT_FOUND', `Document '${filename}' not found`, 404);

	const revisions = await listRevisions(db, doc.id);
	return ok(c, revisions);
});

projectDocsRoutes.post('/projects/:projectId/docs/:filename/restore', async (c) => {
	const teamId = c.get('teamId') as string;

	const auth = c.get('auth');
	if (auth.type === AuthType.Agent) {
		return err(c, 'FORBIDDEN', 'Only the admin can restore revisions', 403);
	}

	const db = c.get('db');
	const filename = c.req.param('filename');
	const projectId = await resolveProjectId(db, teamId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const body = await c.req.json<{ revision_number: number }>();
	if (typeof body.revision_number !== 'number') {
		return err(c, 'INVALID_REQUEST', 'revision_number is required', 400);
	}

	const doc = await getDocument(db, {
		type: DocumentType.ProjectDoc,
		teamId: teamId,
		projectId,
		slug: filename,
	});
	if (!doc) return err(c, 'NOT_FOUND', `Document '${filename}' not found`, 404);

	const restoredByMemberId = await resolveActorMemberId(db, auth, teamId);
	const restored = await restoreRevision(db, c.get('wsManager'), {
		documentId: doc.id,
		revisionNumber: body.revision_number,
		restoredByMemberId,
		audit: { events: c.get('events'), actorType: actorTypeFromAuth(auth) },
	});
	if (!restored) return err(c, 'NOT_FOUND', 'Revision not found', 404);

	return ok(c, {
		id: restored.id,
		filename: restored.slug,
		content: restored.content,
		updated_at: restored.updated_at,
	});
});

projectDocsRoutes.get('/projects/:projectId/agents-md', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const dataDir = c.get('dataDir');
	const projectId = await resolveProjectId(db, teamId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const info = await getDesignatedRepoInfo(db, teamId, projectId);
	if (!info) return err(c, 'NOT_FOUND', 'Project has no designated repo', 404);

	const agentsMdPath = resolveAgentsMdPath(dataDir, info.teamSlug, info.projectSlug, info.repoName);
	const { existsSync, readFileSync } = await import('node:fs');
	if (!existsSync(agentsMdPath)) {
		return err(c, 'NOT_FOUND', 'AGENTS.md not found', 404);
	}

	return ok(c, { filename: 'AGENTS.md', content: readFileSync(agentsMdPath, 'utf-8') });
});

projectDocsRoutes.put('/projects/:projectId/agents-md', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const dataDir = c.get('dataDir');
	const projectId = await resolveProjectId(db, teamId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const info = await getDesignatedRepoInfo(db, teamId, projectId);
	if (!info) return err(c, 'NOT_FOUND', 'Project has no designated repo', 404);

	const body = await c.req.json<{ content: string }>();
	if (body.content === undefined) {
		return err(c, 'INVALID_REQUEST', 'content is required', 400);
	}

	const agentsMdPath = resolveAgentsMdPath(dataDir, info.teamSlug, info.projectSlug, info.repoName);
	const { mkdirSync, writeFileSync } = await import('node:fs');
	const { dirname } = await import('node:path');
	mkdirSync(dirname(agentsMdPath), { recursive: true });
	writeFileSync(agentsMdPath, body.content, 'utf-8');

	return ok(c, { filename: 'AGENTS.md', content: body.content });
});

async function getDesignatedRepoInfo(
	db: import('@electric-sql/pglite').PGlite,
	teamId: string,
	projectId: string,
): Promise<{ teamSlug: string; projectSlug: string; repoName: string } | null> {
	const result = await db.query<{
		team_slug: string;
		project_slug: string;
		repo_identifier: string;
	}>(
		`SELECT co.slug AS team_slug, p.slug AS project_slug, r.repo_identifier
		 FROM projects p
		 JOIN teams co ON co.id = p.team_id
		 JOIN repos r ON r.id = p.designated_repo_id
		 WHERE p.id = $1 AND p.team_id = $2 AND p.designated_repo_id IS NOT NULL`,
		[projectId, teamId],
	);
	const row = result.rows[0];
	if (!row) return null;
	return {
		teamSlug: row.team_slug,
		projectSlug: row.project_slug,
		repoName: repoNameFromIdentifier(row.repo_identifier),
	};
}
