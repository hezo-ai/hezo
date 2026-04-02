import { ContainerStatus, TERMINAL_ISSUE_STATUSES } from '@hezo/shared';
import { Hono } from 'hono';
import { broadcastChange } from '../lib/broadcast';
import { resolveProjectId } from '../lib/resolve';
import { err, ok } from '../lib/response';
import { toSlug, uniqueSlug } from '../lib/slug';
import type { Env } from '../lib/types';
import { requireCompanyAccess } from '../middleware/auth';
import {
	type ProjectRow,
	provisionContainer,
	rebuildContainer,
	teardownContainer,
} from '../services/containers';

export const projectsRoutes = new Hono<Env>();

const terminalStatusList = TERMINAL_ISSUE_STATUSES.map((s) => `'${s}'`).join(', ');

projectsRoutes.get('/companies/:companyId/projects', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;

	const result = await db.query(
		`SELECT p.*,
       (SELECT count(*) FROM repos r WHERE r.project_id = p.id)::int AS repo_count,
       (SELECT count(*) FROM issues i WHERE i.project_id = p.id AND i.status NOT IN (${terminalStatusList}))::int AS open_issue_count
     FROM projects p
     WHERE p.company_id = $1
     ORDER BY p.created_at DESC`,
		[companyId],
	);
	return ok(c, result.rows);
});

projectsRoutes.post('/companies/:companyId/projects', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;

	const companyCheck = await db.query('SELECT id FROM companies WHERE id = $1', [companyId]);
	if (companyCheck.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Company not found', 404);
	}

	const body = await c.req.json<{
		name: string;
		goal?: string;
		docker_base_image?: string;
	}>();

	if (!body.name?.trim()) {
		return err(c, 'INVALID_REQUEST', 'name is required', 400);
	}

	const slug = await uniqueSlug(toSlug(body.name), async (s) => {
		const r = await db.query('SELECT 1 FROM projects WHERE company_id = $1 AND slug = $2', [
			companyId,
			s,
		]);
		return r.rows.length > 0;
	});

	const result = await db.query(
		`INSERT INTO projects (company_id, name, slug, goal, docker_base_image)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
		[companyId, body.name.trim(), slug, body.goal ?? '', body.docker_base_image ?? 'node:24-slim'],
	);

	const project = result.rows[0] as Record<string, unknown>;
	broadcastChange(c, `company:${companyId}`, 'projects', 'INSERT', project);

	const companySlugResult = await db.query<{ slug: string }>(
		'SELECT slug FROM companies WHERE id = $1',
		[companyId],
	);
	const companySlug = companySlugResult.rows[0]?.slug;

	if (companySlug) {
		const docker = c.get('docker');
		const dataDir = c.get('dataDir');
		provisionContainer(db, docker, project as unknown as ProjectRow, companySlug, dataDir).catch(
			(error) => {
				console.error(`Failed to provision container for project ${project.slug}:`, error);
			},
		);
	}

	return ok(c, project, 201);
});

projectsRoutes.get('/companies/:companyId/projects/:projectId', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const projectId = await resolveProjectId(db, companyId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const result = await db.query(
		`SELECT p.*,
       (SELECT count(*) FROM repos r WHERE r.project_id = p.id)::int AS repo_count,
       (SELECT count(*) FROM issues i WHERE i.project_id = p.id AND i.status NOT IN (${terminalStatusList}))::int AS open_issue_count
     FROM projects p
     WHERE p.id = $1 AND p.company_id = $2`,
		[projectId, companyId],
	);

	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Project not found', 404);
	}

	const repos = await db.query('SELECT * FROM repos WHERE project_id = $1 ORDER BY short_name', [
		projectId,
	]);

	return ok(c, { ...(result.rows[0] as Record<string, unknown>), repos: repos.rows });
});

projectsRoutes.patch('/companies/:companyId/projects/:projectId', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const projectId = await resolveProjectId(db, companyId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const existing = await db.query('SELECT id FROM projects WHERE id = $1 AND company_id = $2', [
		projectId,
		companyId,
	]);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Project not found', 404);
	}

	const body = await c.req.json<{
		name?: string;
		goal?: string;
	}>();

	const sets: string[] = [];
	const params: unknown[] = [];
	let idx = 1;

	if (body.name?.trim()) {
		const newSlug = await uniqueSlug(toSlug(body.name), async (s) => {
			const r = await db.query(
				'SELECT 1 FROM projects WHERE company_id = $1 AND slug = $2 AND id != $3',
				[companyId, s, projectId],
			);
			return r.rows.length > 0;
		});
		sets.push(`name = $${idx}`);
		params.push(body.name.trim());
		idx++;
		sets.push(`slug = $${idx}`);
		params.push(newSlug);
		idx++;
	}
	if (body.goal !== undefined) {
		sets.push(`goal = $${idx}`);
		params.push(body.goal);
		idx++;
	}

	if (sets.length === 0) {
		const result = await db.query('SELECT * FROM projects WHERE id = $1', [projectId]);
		return ok(c, result.rows[0]);
	}

	params.push(projectId);
	const result = await db.query(
		`UPDATE projects SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
		params,
	);

	broadcastChange(
		c,
		`company:${companyId}`,
		'projects',
		'UPDATE',
		result.rows[0] as Record<string, unknown>,
	);
	return ok(c, result.rows[0]);
});

projectsRoutes.delete('/companies/:companyId/projects/:projectId', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const projectId = await resolveProjectId(db, companyId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const existing = await db.query<{ id: string; slug: string }>(
		'SELECT id, slug FROM projects WHERE id = $1 AND company_id = $2',
		[projectId, companyId],
	);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Project not found', 404);
	}

	const openIssues = await db.query<{ count: number }>(
		`SELECT count(*)::int AS count FROM issues WHERE project_id = $1 AND status NOT IN (${terminalStatusList})`,
		[projectId],
	);
	if (openIssues.rows[0].count > 0) {
		return err(c, 'CONFLICT', 'Cannot delete project with open issues', 409);
	}

	const companySlugResult = await db.query<{ slug: string }>(
		'SELECT slug FROM companies WHERE id = $1',
		[companyId],
	);
	const companySlug = companySlugResult.rows[0]?.slug;

	if (companySlug) {
		const docker = c.get('docker');
		const dataDir = c.get('dataDir');
		await teardownContainer(
			db,
			docker,
			projectId,
			companySlug,
			existing.rows[0].slug,
			dataDir,
		).catch((error) => {
			console.error(`Failed to teardown container for project ${existing.rows[0].slug}:`, error);
		});
	}

	await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
	broadcastChange(c, `company:${companyId}`, 'projects', 'DELETE', { id: projectId });
	return c.json({ data: null }, 200);
});

projectsRoutes.post('/companies/:companyId/projects/:projectId/rebuild-container', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const projectId = await resolveProjectId(db, companyId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const projectResult = await db.query('SELECT * FROM projects WHERE id = $1 AND company_id = $2', [
		projectId,
		companyId,
	]);
	if (projectResult.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Project not found', 404);
	}

	const companySlugResult = await db.query<{ slug: string }>(
		'SELECT slug FROM companies WHERE id = $1',
		[companyId],
	);
	const companySlug = companySlugResult.rows[0]?.slug;
	if (!companySlug) {
		return err(c, 'NOT_FOUND', 'Company not found', 404);
	}

	const docker = c.get('docker');
	const dataDir = c.get('dataDir');

	try {
		const containerId = await rebuildContainer(
			db,
			docker,
			projectResult.rows[0] as ProjectRow,
			companySlug,
			dataDir,
		);
		return ok(c, { container_id: containerId, container_status: ContainerStatus.Running });
	} catch (error) {
		return err(c, 'DOCKER_ERROR', `Failed to rebuild container: ${(error as Error).message}`, 500);
	}
});
