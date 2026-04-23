import { ApprovalType, AuthType, DocumentType } from '@hezo/shared';
import { Hono } from 'hono';
import { resolveAgentsMdPath } from '../lib/docs';
import { resolveActorMemberId, resolveProjectId } from '../lib/resolve';
import { err, ok } from '../lib/response';
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

export const projectDocsRoutes = new Hono<Env>();

projectDocsRoutes.get('/companies/:companyId/projects/:projectId/docs', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const projectId = await resolveProjectId(db, access.companyId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const docs = await listDocuments(db, {
		type: DocumentType.ProjectDoc,
		companyId: access.companyId,
		projectId,
	});

	return ok(
		c,
		docs.map((d) => ({ id: d.id, filename: d.slug, updated_at: d.updated_at })),
	);
});

projectDocsRoutes.get('/companies/:companyId/projects/:projectId/docs/:filename', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const filename = c.req.param('filename');
	const projectId = await resolveProjectId(db, access.companyId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const doc = await getDocument(db, {
		type: DocumentType.ProjectDoc,
		companyId: access.companyId,
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

projectDocsRoutes.put('/companies/:companyId/projects/:projectId/docs/:filename', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const filename = c.req.param('filename');
	const auth = c.get('auth');
	const projectId = await resolveProjectId(db, access.companyId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const body = await c.req.json<{ content: string; change_summary?: string }>();
	if (body.content === undefined) {
		return err(c, 'INVALID_REQUEST', 'content is required', 400);
	}

	if (filename === 'prd.md' && auth.type === AuthType.Agent) {
		await db.query(
			`INSERT INTO approvals (company_id, type, requested_by_member_id, payload)
			 VALUES ($1, $2::approval_type, $3, $4::jsonb)`,
			[
				access.companyId,
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
		return c.json({ data: { pending_approval: true, filename } }, 202);
	}

	const memberId = await resolveActorMemberId(db, auth, access.companyId);

	const doc = await upsertDocument(db, c.get('wsManager'), {
		scope: {
			type: DocumentType.ProjectDoc,
			companyId: access.companyId,
			projectId,
			slug: filename,
		},
		content: body.content,
		changeSummary: body.change_summary,
		authorMemberId: memberId,
	});

	return ok(c, {
		id: doc.id,
		filename: doc.slug,
		content: doc.content,
		updated_at: doc.updated_at,
	});
});

projectDocsRoutes.delete('/companies/:companyId/projects/:projectId/docs/:filename', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const filename = c.req.param('filename');
	const projectId = await resolveProjectId(db, access.companyId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const removed = await deleteDocument(db, c.get('wsManager'), {
		type: DocumentType.ProjectDoc,
		companyId: access.companyId,
		projectId,
		slug: filename,
	});
	if (!removed) return err(c, 'NOT_FOUND', `Document '${filename}' not found`, 404);

	return c.json({ data: null }, 200);
});

projectDocsRoutes.get(
	'/companies/:companyId/projects/:projectId/docs/:filename/revisions',
	async (c) => {
		const access = await requireCompanyAccess(c);
		if (access instanceof Response) return access;

		const db = c.get('db');
		const filename = c.req.param('filename');
		const projectId = await resolveProjectId(db, access.companyId, c.req.param('projectId'));
		if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

		const doc = await getDocument(db, {
			type: DocumentType.ProjectDoc,
			companyId: access.companyId,
			projectId,
			slug: filename,
		});
		if (!doc) return err(c, 'NOT_FOUND', `Document '${filename}' not found`, 404);

		const revisions = await listRevisions(db, doc.id);
		return ok(c, revisions);
	},
);

projectDocsRoutes.post(
	'/companies/:companyId/projects/:projectId/docs/:filename/restore',
	async (c) => {
		const access = await requireCompanyAccess(c);
		if (access instanceof Response) return access;

		const auth = c.get('auth');
		if (auth.type === AuthType.Agent) {
			return err(c, 'FORBIDDEN', 'Only board members can restore revisions', 403);
		}

		const db = c.get('db');
		const filename = c.req.param('filename');
		const projectId = await resolveProjectId(db, access.companyId, c.req.param('projectId'));
		if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

		const body = await c.req.json<{ revision_number: number }>();
		if (typeof body.revision_number !== 'number') {
			return err(c, 'INVALID_REQUEST', 'revision_number is required', 400);
		}

		const doc = await getDocument(db, {
			type: DocumentType.ProjectDoc,
			companyId: access.companyId,
			projectId,
			slug: filename,
		});
		if (!doc) return err(c, 'NOT_FOUND', `Document '${filename}' not found`, 404);

		const restoredByMemberId = await resolveActorMemberId(db, auth, access.companyId);
		const restored = await restoreRevision(db, c.get('wsManager'), {
			documentId: doc.id,
			revisionNumber: body.revision_number,
			restoredByMemberId,
		});
		if (!restored) return err(c, 'NOT_FOUND', 'Revision not found', 404);

		return ok(c, {
			id: restored.id,
			filename: restored.slug,
			content: restored.content,
			updated_at: restored.updated_at,
		});
	},
);

projectDocsRoutes.get('/companies/:companyId/projects/:projectId/agents-md', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const dataDir = c.get('dataDir');
	const projectId = await resolveProjectId(db, access.companyId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const info = await getDesignatedRepoInfo(db, access.companyId, projectId);
	if (!info) return err(c, 'NOT_FOUND', 'Project has no designated repo', 404);

	const agentsMdPath = resolveAgentsMdPath(
		dataDir,
		info.companySlug,
		info.projectSlug,
		info.repoShortName,
	);
	const { existsSync, readFileSync } = await import('node:fs');
	if (!existsSync(agentsMdPath)) {
		return err(c, 'NOT_FOUND', 'AGENTS.md not found', 404);
	}

	return ok(c, { filename: 'AGENTS.md', content: readFileSync(agentsMdPath, 'utf-8') });
});

projectDocsRoutes.put('/companies/:companyId/projects/:projectId/agents-md', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const dataDir = c.get('dataDir');
	const projectId = await resolveProjectId(db, access.companyId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const info = await getDesignatedRepoInfo(db, access.companyId, projectId);
	if (!info) return err(c, 'NOT_FOUND', 'Project has no designated repo', 404);

	const body = await c.req.json<{ content: string }>();
	if (body.content === undefined) {
		return err(c, 'INVALID_REQUEST', 'content is required', 400);
	}

	const agentsMdPath = resolveAgentsMdPath(
		dataDir,
		info.companySlug,
		info.projectSlug,
		info.repoShortName,
	);
	const { mkdirSync, writeFileSync } = await import('node:fs');
	const { dirname } = await import('node:path');
	mkdirSync(dirname(agentsMdPath), { recursive: true });
	writeFileSync(agentsMdPath, body.content, 'utf-8');

	return ok(c, { filename: 'AGENTS.md', content: body.content });
});

async function getDesignatedRepoInfo(
	db: import('@electric-sql/pglite').PGlite,
	companyId: string,
	projectId: string,
): Promise<{ companySlug: string; projectSlug: string; repoShortName: string } | null> {
	const result = await db.query<{
		company_slug: string;
		project_slug: string;
		repo_short_name: string;
	}>(
		`SELECT co.slug AS company_slug, p.slug AS project_slug, r.short_name AS repo_short_name
		 FROM projects p
		 JOIN companies co ON co.id = p.company_id
		 JOIN repos r ON r.id = p.designated_repo_id
		 WHERE p.id = $1 AND p.company_id = $2 AND p.designated_repo_id IS NOT NULL`,
		[projectId, companyId],
	);
	const row = result.rows[0];
	if (!row) return null;
	return {
		companySlug: row.company_slug,
		projectSlug: row.project_slug,
		repoShortName: row.repo_short_name,
	};
}
