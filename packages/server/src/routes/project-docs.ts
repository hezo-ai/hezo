import { ApprovalType, AuthType } from '@hezo/shared';
import { Hono } from 'hono';
import { resolveAgentsMdPath } from '../lib/docs';
import { resolveProjectId } from '../lib/resolve';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { requireCompanyAccess } from '../middleware/auth';

export const projectDocsRoutes = new Hono<Env>();

projectDocsRoutes.get('/companies/:companyId/projects/:projectId/docs', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const projectId = await resolveProjectId(db, access.companyId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const result = await db.query<{ id: string; filename: string; updated_at: string }>(
		'SELECT id, filename, updated_at FROM project_docs WHERE project_id = $1 ORDER BY filename',
		[projectId],
	);

	return ok(c, result.rows);
});

projectDocsRoutes.get('/companies/:companyId/projects/:projectId/docs/:filename', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const filename = c.req.param('filename');
	const projectId = await resolveProjectId(db, access.companyId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const result = await db.query<{
		id: string;
		filename: string;
		content: string;
		updated_at: string;
	}>(
		'SELECT id, filename, content, updated_at FROM project_docs WHERE project_id = $1 AND filename = $2',
		[projectId, filename],
	);

	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', `Document '${filename}' not found`, 404);
	}

	return ok(c, result.rows[0]);
});

projectDocsRoutes.put('/companies/:companyId/projects/:projectId/docs/:filename', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const filename = c.req.param('filename');
	const auth = c.get('auth');
	const projectId = await resolveProjectId(db, access.companyId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const body = await c.req.json<{ content: string }>();
	if (body.content === undefined) {
		return err(c, 'INVALID_REQUEST', 'content is required', 400);
	}

	// PRD updates from agents require board approval
	if (filename === 'prd.md' && auth.type === AuthType.Agent) {
		await db.query(
			`INSERT INTO approvals (company_id, type, requested_by_member_id, payload)
			 VALUES ($1, $2::approval_type, $3, $4::jsonb)`,
			[
				access.companyId,
				ApprovalType.Strategy,
				auth.memberId,
				JSON.stringify({ action: 'update_prd', filename, content: body.content }),
			],
		);
		return c.json({ data: { pending_approval: true, filename } }, 202);
	}

	const memberId = auth.type === AuthType.Agent ? auth.memberId : null;

	const result = await db.query<{
		id: string;
		filename: string;
		content: string;
		updated_at: string;
	}>(
		`INSERT INTO project_docs (project_id, company_id, filename, content, last_updated_by_member_id)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (project_id, filename) DO UPDATE SET
		   content = EXCLUDED.content,
		   last_updated_by_member_id = EXCLUDED.last_updated_by_member_id,
		   updated_at = now()
		 RETURNING id, filename, content, updated_at`,
		[projectId, access.companyId, filename, body.content, memberId],
	);

	return ok(c, result.rows[0]);
});

projectDocsRoutes.delete('/companies/:companyId/projects/:projectId/docs/:filename', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const filename = c.req.param('filename');
	const projectId = await resolveProjectId(db, access.companyId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const result = await db.query(
		'DELETE FROM project_docs WHERE project_id = $1 AND filename = $2 RETURNING id',
		[projectId, filename],
	);

	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', `Document '${filename}' not found`, 404);
	}

	return c.json({ data: null }, 200);
});

// AGENTS.md stays filesystem-based — it's a git-tracked file in the repo
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
