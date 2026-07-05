import {
	ApprovalType,
	AuthType,
	DocumentStatus,
	DocumentType,
	isMarkdownDocSlug,
	repoNameFromIdentifier,
} from '@hezo/shared';
import { Hono } from 'hono';
import { resolveAgentsMdPath } from '../lib/docs';
import {
	actorTypeFromAuth,
	apiKeyIdFromAuth,
	resolveActorMemberId,
	resolveProjectId,
} from '../lib/resolve';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { broadcastApprovalChange } from '../services/approval-broadcast';
import {
	type DocumentRowWithAuthor,
	deleteDocument,
	getDocument,
	listDocuments,
	listRevisions,
	restoreRevision,
	setDocumentArchived,
	setDocumentStatus,
	upsertDocument,
} from '../services/documents';

export const projectDocsRoutes = new Hono<Env>();

/** The single-document API shape — includes the timestamps + last editor the metadata banner renders. */
function toDocResponse(d: DocumentRowWithAuthor) {
	return {
		id: d.id,
		filename: d.slug,
		content: d.content,
		status: d.status,
		created_at: d.created_at,
		updated_at: d.updated_at,
		last_updated_by_name: d.last_updated_by_name,
		last_updated_by_type: d.last_updated_by_type,
		archived_at: d.archived_at,
		archived_by_name: d.archived_by_name,
	};
}

projectDocsRoutes.get('/projects/:projectId/docs', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const projectId = await resolveProjectId(db, teamId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	// The list carries archived docs too: the web UI filters client-side
	// (Active / Archived / All with counts) and old references must keep
	// resolving. Agent-facing surfaces (MCP, run context) stay active-only.
	const docs = await listDocuments(db, {
		type: DocumentType.ProjectDoc,
		teamId: teamId,
		projectId,
		includeArchived: true,
	});

	return ok(
		c,
		docs.map((d) => ({
			id: d.id,
			filename: d.slug,
			status: d.status,
			updated_at: d.updated_at,
			archived_at: d.archived_at,
		})),
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

	return ok(c, toDocResponse(doc));
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

	// Archived docs are read-only: restore first, then edit. Creating a new doc
	// under an archived name would silently resurrect old history otherwise.
	const prior = await getDocument(db, {
		type: DocumentType.ProjectDoc,
		teamId,
		projectId,
		slug: filename,
	});
	if (prior?.archived_at) {
		return err(c, 'CONFLICT', `Document '${filename}' is archived — restore it first`, 409);
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
		authorApiKeyId: apiKeyIdFromAuth(auth),
		audit: {
			events: c.get('events'),
			actorType: actorTypeFromAuth(auth),
			actorApiKeyId: apiKeyIdFromAuth(auth),
		},
	});

	// Re-read WITH_AUTHOR so the response carries created_at + resolved last editor.
	const saved = await getDocument(db, {
		type: DocumentType.ProjectDoc,
		teamId,
		projectId,
		slug: filename,
	});
	return ok(
		c,
		toDocResponse(
			saved ?? {
				...doc,
				last_updated_by_name: null,
				last_updated_by_type: 'admin',
				archived_by_name: null,
			},
		),
	);
});

projectDocsRoutes.patch('/projects/:projectId/docs/:filename', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const filename = c.req.param('filename');
	const auth = c.get('auth');
	const projectId = await resolveProjectId(db, teamId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const body = await c.req.json<{ status?: string; archived?: boolean }>();
	const scope = { type: DocumentType.ProjectDoc, teamId, projectId, slug: filename } as const;
	const audit = {
		events: c.get('events'),
		actorType: actorTypeFromAuth(auth),
		actorApiKeyId: apiKeyIdFromAuth(auth),
	};
	const actorMemberId = await resolveActorMemberId(db, auth, teamId);

	// Exactly one mutable field per call: a status flip and an archive flip are
	// different actions with different guards.
	const hasStatus = body.status !== undefined;
	const hasArchived = body.archived !== undefined;
	if (hasStatus === hasArchived) {
		return err(c, 'INVALID_REQUEST', 'Provide exactly one of: status, archived', 400);
	}

	if (hasArchived) {
		if (typeof body.archived !== 'boolean') {
			return err(c, 'INVALID_REQUEST', 'archived must be a boolean', 400);
		}
		const result = await setDocumentArchived(
			db,
			c.get('wsManager'),
			scope,
			body.archived,
			actorMemberId,
			audit,
		);
		if (!result) return err(c, 'NOT_FOUND', `Document '${filename}' not found`, 404);
	} else {
		if (!Object.values(DocumentStatus).includes(body.status as DocumentStatus)) {
			return err(
				c,
				'INVALID_REQUEST',
				`status must be one of: ${Object.values(DocumentStatus).join(', ')}`,
				400,
			);
		}
		const current = await getDocument(db, scope);
		if (!current) return err(c, 'NOT_FOUND', `Document '${filename}' not found`, 404);
		if (current.archived_at) {
			return err(c, 'CONFLICT', `Document '${filename}' is archived — restore it first`, 409);
		}
		const row = await setDocumentStatus(
			db,
			c.get('wsManager'),
			scope,
			body.status as DocumentStatus,
			actorMemberId,
			audit,
		);
		if (!row) return err(c, 'NOT_FOUND', `Document '${filename}' not found`, 404);
	}

	// Re-read WITH_AUTHOR so the response carries the resolved last editor.
	const saved = await getDocument(db, scope);
	if (!saved) return err(c, 'NOT_FOUND', `Document '${filename}' not found`, 404);
	return ok(c, toDocResponse(saved));
});

projectDocsRoutes.delete('/projects/:projectId/docs/:filename', async (c) => {
	const teamId = c.get('teamId') as string;
	const auth = c.get('auth');
	if (auth.type === AuthType.Agent) {
		return err(
			c,
			'FORBIDDEN',
			'Only the admin can delete documents — archive instead (archive_project_doc)',
			403,
		);
	}
	const db = c.get('db');
	const filename = c.req.param('filename');
	const projectId = await resolveProjectId(db, teamId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

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
		{
			events: c.get('events'),
			actorType: actorTypeFromAuth(c.get('auth')),
			actorApiKeyId: apiKeyIdFromAuth(c.get('auth')),
			actorMemberId,
		},
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
	if (doc.archived_at) {
		return err(c, 'CONFLICT', `Document '${filename}' is archived — restore it first`, 409);
	}

	const restoredByMemberId = await resolveActorMemberId(db, auth, teamId);
	const restored = await restoreRevision(db, c.get('wsManager'), {
		documentId: doc.id,
		revisionNumber: body.revision_number,
		restoredByMemberId,
		restoredByApiKeyId: apiKeyIdFromAuth(auth),
		audit: {
			events: c.get('events'),
			actorType: actorTypeFromAuth(auth),
			actorApiKeyId: apiKeyIdFromAuth(auth),
		},
	});
	if (!restored) return err(c, 'NOT_FOUND', 'Revision not found', 404);

	const saved = await getDocument(db, {
		type: DocumentType.ProjectDoc,
		teamId,
		projectId,
		slug: filename,
	});
	return ok(
		c,
		toDocResponse(
			saved ?? {
				...restored,
				last_updated_by_name: null,
				last_updated_by_type: 'admin',
				archived_by_name: null,
			},
		),
	);
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
