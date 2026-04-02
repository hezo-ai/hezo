import type { PGlite } from '@electric-sql/pglite';
import { ApprovalType, AuthType } from '@hezo/shared';
import { Hono } from 'hono';
import {
	deleteDocFile,
	listDocFiles,
	readDocFile,
	resolveAgentsMdPath,
	resolveDevDocsPath,
	writeDocFile,
} from '../lib/docs';
import { resolveProjectId } from '../lib/resolve';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { requireCompanyAccess } from '../middleware/auth';

export const projectDocsRoutes = new Hono<Env>();

interface DesignatedRepoInfo {
	companySlug: string;
	projectSlug: string;
	repoShortName: string;
}

async function getDesignatedRepoInfo(
	db: PGlite,
	companyId: string,
	projectId: string,
): Promise<DesignatedRepoInfo | null> {
	const result = await db.query<{
		company_slug: string;
		project_slug: string;
		repo_short_name: string;
	}>(
		`SELECT
			co.issue_prefix AS company_slug,
			p.name AS project_slug,
			r.short_name AS repo_short_name
		FROM projects p
		JOIN companies co ON co.id = p.company_id
		JOIN repos r ON r.id = p.designated_repo_id
		WHERE p.id = $1 AND p.company_id = $2 AND p.designated_repo_id IS NOT NULL`,
		[projectId, companyId],
	);

	if (result.rows.length === 0) return null;

	const row = result.rows[0];
	return {
		companySlug: row.company_slug.toLowerCase(),
		projectSlug: row.project_slug.toLowerCase().replace(/\s+/g, '-'),
		repoShortName: row.repo_short_name,
	};
}

projectDocsRoutes.get('/companies/:companyId/projects/:projectId/docs', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const dataDir = c.get('dataDir');
	const projectId = await resolveProjectId(db, access.companyId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);
	const info = await getDesignatedRepoInfo(db, access.companyId, projectId);

	if (!info) {
		return err(c, 'NOT_FOUND', 'Project has no designated repo', 404);
	}

	const devDocsPath = resolveDevDocsPath(
		dataDir,
		info.companySlug,
		info.projectSlug,
		info.repoShortName,
	);
	const files = listDocFiles(devDocsPath);

	return ok(
		c,
		files.map((filename) => ({
			filename,
			path: `.dev/${filename}`,
		})),
	);
});

projectDocsRoutes.get('/companies/:companyId/projects/:projectId/docs/:filename', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const dataDir = c.get('dataDir');
	const filename = c.req.param('filename');
	const projectId = await resolveProjectId(db, access.companyId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);
	const info = await getDesignatedRepoInfo(db, access.companyId, projectId);

	if (!info) {
		return err(c, 'NOT_FOUND', 'Project has no designated repo', 404);
	}

	const devDocsPath = resolveDevDocsPath(
		dataDir,
		info.companySlug,
		info.projectSlug,
		info.repoShortName,
	);
	const content = readDocFile(devDocsPath, filename);

	if (content === null) {
		return err(c, 'NOT_FOUND', `Document '${filename}' not found`, 404);
	}

	return ok(c, { filename, path: `.dev/${filename}`, content });
});

projectDocsRoutes.put('/companies/:companyId/projects/:projectId/docs/:filename', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const dataDir = c.get('dataDir');
	const filename = c.req.param('filename');
	const auth = c.get('auth');
	const projectId = await resolveProjectId(db, access.companyId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);
	const info = await getDesignatedRepoInfo(db, access.companyId, projectId);

	if (!info) {
		return err(c, 'NOT_FOUND', 'Project has no designated repo', 404);
	}

	const body = await c.req.json<{ content: string }>();
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
				JSON.stringify({ action: 'update_prd', filename, content: body.content }),
			],
		);
		return c.json({ data: { pending_approval: true, filename } }, 202);
	}

	const devDocsPath = resolveDevDocsPath(
		dataDir,
		info.companySlug,
		info.projectSlug,
		info.repoShortName,
	);
	writeDocFile(devDocsPath, filename, body.content);

	return ok(c, { filename, path: `.dev/${filename}`, content: body.content });
});

projectDocsRoutes.delete('/companies/:companyId/projects/:projectId/docs/:filename', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const dataDir = c.get('dataDir');
	const filename = c.req.param('filename');
	const projectId = await resolveProjectId(db, access.companyId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);
	const info = await getDesignatedRepoInfo(db, access.companyId, projectId);

	if (!info) {
		return err(c, 'NOT_FOUND', 'Project has no designated repo', 404);
	}

	const devDocsPath = resolveDevDocsPath(
		dataDir,
		info.companySlug,
		info.projectSlug,
		info.repoShortName,
	);
	const deleted = deleteDocFile(devDocsPath, filename);

	if (!deleted) {
		return err(c, 'NOT_FOUND', `Document '${filename}' not found`, 404);
	}

	return c.json({ data: null }, 200);
});

projectDocsRoutes.get('/companies/:companyId/projects/:projectId/agents-md', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const dataDir = c.get('dataDir');
	const projectId = await resolveProjectId(db, access.companyId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);
	const info = await getDesignatedRepoInfo(db, access.companyId, projectId);

	if (!info) {
		return err(c, 'NOT_FOUND', 'Project has no designated repo', 404);
	}

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

	const content = readFileSync(agentsMdPath, 'utf-8');
	return ok(c, { filename: 'AGENTS.md', content });
});

projectDocsRoutes.put('/companies/:companyId/projects/:projectId/agents-md', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const dataDir = c.get('dataDir');
	const projectId = await resolveProjectId(db, access.companyId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);
	const info = await getDesignatedRepoInfo(db, access.companyId, projectId);

	if (!info) {
		return err(c, 'NOT_FOUND', 'Project has no designated repo', 404);
	}

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
