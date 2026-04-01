import { Hono } from 'hono';
import { err, ok } from '../lib/response';
import { toSlug, uniqueSlug } from '../lib/slug';
import type { Env } from '../lib/types';

export const projectsRoutes = new Hono<Env>();

projectsRoutes.get('/companies/:companyId/projects', async (c) => {
	const db = c.get('db');
	const result = await db.query(
		`SELECT p.*,
       (SELECT count(*) FROM repos r WHERE r.project_id = p.id)::int AS repo_count,
       (SELECT count(*) FROM issues i WHERE i.project_id = p.id AND i.status NOT IN ('done', 'closed', 'cancelled'))::int AS open_issue_count
     FROM projects p
     WHERE p.company_id = $1
     ORDER BY p.created_at DESC`,
		[c.req.param('companyId')],
	);
	return ok(c, result.rows);
});

projectsRoutes.post('/companies/:companyId/projects', async (c) => {
	const db = c.get('db');
	const companyId = c.req.param('companyId');

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
		[companyId, body.name.trim(), slug, body.goal ?? '', body.docker_base_image ?? 'node:20-slim'],
	);

	return ok(c, result.rows[0], 201);
});

projectsRoutes.get('/companies/:companyId/projects/:projectId', async (c) => {
	const db = c.get('db');
	const result = await db.query(
		`SELECT p.*,
       (SELECT count(*) FROM repos r WHERE r.project_id = p.id)::int AS repo_count,
       (SELECT count(*) FROM issues i WHERE i.project_id = p.id AND i.status NOT IN ('done', 'closed', 'cancelled'))::int AS open_issue_count
     FROM projects p
     WHERE p.id = $1 AND p.company_id = $2`,
		[c.req.param('projectId'), c.req.param('companyId')],
	);

	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Project not found', 404);
	}

	// Also fetch repos
	const repos = await db.query('SELECT * FROM repos WHERE project_id = $1 ORDER BY short_name', [
		c.req.param('projectId'),
	]);

	return ok(c, { ...(result.rows[0] as Record<string, unknown>), repos: repos.rows });
});

projectsRoutes.patch('/companies/:companyId/projects/:projectId', async (c) => {
	const db = c.get('db');
	const projectId = c.req.param('projectId');
	const companyId = c.req.param('companyId');

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

	return ok(c, result.rows[0]);
});

projectsRoutes.delete('/companies/:companyId/projects/:projectId', async (c) => {
	const db = c.get('db');
	const projectId = c.req.param('projectId');
	const companyId = c.req.param('companyId');

	const existing = await db.query('SELECT id FROM projects WHERE id = $1 AND company_id = $2', [
		projectId,
		companyId,
	]);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Project not found', 404);
	}

	// Check for open issues
	const openIssues = await db.query<{ count: number }>(
		"SELECT count(*)::int AS count FROM issues WHERE project_id = $1 AND status NOT IN ('done', 'closed', 'cancelled')",
		[projectId],
	);
	if (openIssues.rows[0].count > 0) {
		return err(c, 'CONFLICT', 'Cannot delete project with open issues', 409);
	}

	await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
	return c.json({ data: null }, 200);
});
