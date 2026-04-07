import type { PGlite } from '@electric-sql/pglite';
import { ContainerStatus, TERMINAL_ISSUE_STATUSES, WakeupSource } from '@hezo/shared';
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
	stopContainerGracefully,
	teardownContainer,
} from '../services/containers';
import type { JobManager } from '../services/job-manager';
import { createWakeup } from '../services/wakeup';

async function cancelRunningAgentTasks(
	db: PGlite,
	jobManager: JobManager,
	projectId: string,
	companyId: string,
): Promise<void> {
	const running = await db.query<{ assignee_id: string }>(
		`SELECT DISTINCT i.assignee_id
		 FROM issues i
		 JOIN execution_locks el ON el.issue_id = i.id AND el.released_at IS NULL
		 WHERE i.project_id = $1 AND i.company_id = $2 AND i.assignee_id IS NOT NULL`,
		[projectId, companyId],
	);
	for (const row of running.rows) {
		jobManager.cancelTask(`agent:${row.assignee_id}`);
	}
}

async function wakeAgentsWithPendingWork(
	db: PGlite,
	projectId: string,
	companyId: string,
): Promise<void> {
	const { placeholders, values } = terminalStatusParams(3);
	const pending = await db.query<{ agent_id: string }>(
		`SELECT DISTINCT i.assignee_id AS agent_id
		 FROM issues i
		 JOIN member_agents ma ON ma.id = i.assignee_id
		 WHERE i.project_id = $1 AND i.company_id = $2
		   AND i.status NOT IN (${placeholders})
		   AND ma.admin_status = 'enabled'`,
		[projectId, companyId, ...values],
	);
	for (const row of pending.rows) {
		createWakeup(db, row.agent_id, companyId, WakeupSource.Automation, {
			trigger: 'container_start',
			project_id: projectId,
		}).catch((e) => console.error('[wakeup] Failed to create wakeup on container start:', e));
	}
}

export const projectsRoutes = new Hono<Env>();

/** Generate parameterized placeholders for terminal issue statuses, starting at the given index. */
function terminalStatusParams(startIdx: number): { placeholders: string; values: string[] } {
	const placeholders = TERMINAL_ISSUE_STATUSES.map((_, i) => `$${startIdx + i}::issue_status`).join(
		', ',
	);
	return { placeholders, values: [...TERMINAL_ISSUE_STATUSES] };
}

projectsRoutes.get('/companies/:companyId/projects', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;

	const ts = terminalStatusParams(2);
	const result = await db.query(
		`SELECT p.*,
       (SELECT count(*) FROM repos r WHERE r.project_id = p.id)::int AS repo_count,
       (SELECT count(*) FROM issues i WHERE i.project_id = p.id AND i.status NOT IN (${ts.placeholders}))::int AS open_issue_count
     FROM projects p
     WHERE p.company_id = $1
     ORDER BY p.created_at DESC`,
		[companyId, ...ts.values],
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
		const wsManager = c.get('wsManager');
		provisionContainer(
			db,
			docker,
			project as unknown as ProjectRow,
			companySlug,
			dataDir,
			wsManager,
			companyId,
		).catch((error) => {
			console.error(`Failed to provision container for project ${project.slug}:`, error);
		});
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

	const ts2 = terminalStatusParams(3);
	const result = await db.query(
		`SELECT p.*,
       (SELECT count(*) FROM repos r WHERE r.project_id = p.id)::int AS repo_count,
       (SELECT count(*) FROM issues i WHERE i.project_id = p.id AND i.status NOT IN (${ts2.placeholders}))::int AS open_issue_count
     FROM projects p
     WHERE p.id = $1 AND p.company_id = $2`,
		[projectId, companyId, ...ts2.values],
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

	const existing = await db.query<{ id: string; slug: string; is_internal: boolean }>(
		'SELECT id, slug, is_internal FROM projects WHERE id = $1 AND company_id = $2',
		[projectId, companyId],
	);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Project not found', 404);
	}
	if (existing.rows[0].is_internal) {
		return err(c, 'FORBIDDEN', 'Cannot delete an internal project', 403);
	}

	const ts3 = terminalStatusParams(2);
	const openIssues = await db.query<{ count: number }>(
		`SELECT count(*)::int AS count FROM issues WHERE project_id = $1 AND status NOT IN (${ts3.placeholders})`,
		[projectId, ...ts3.values],
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

projectsRoutes.post('/companies/:companyId/projects/:projectId/container/start', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const projectId = await resolveProjectId(db, companyId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const result = await db.query<{ container_id: string | null }>(
		'SELECT container_id FROM projects WHERE id = $1 AND company_id = $2',
		[projectId, companyId],
	);
	if (result.rows.length === 0) return err(c, 'NOT_FOUND', 'Project not found', 404);
	if (!result.rows[0].container_id) return err(c, 'NO_CONTAINER', 'No container provisioned', 400);

	const docker = c.get('docker');
	try {
		await docker.startContainer(result.rows[0].container_id);
		await db.query('UPDATE projects SET container_status = $1::container_status WHERE id = $2', [
			ContainerStatus.Running,
			projectId,
		]);
		broadcastChange(c, `company:${companyId}`, 'projects', 'UPDATE', {
			id: projectId,
			container_status: ContainerStatus.Running,
		});
		wakeAgentsWithPendingWork(db, projectId, companyId);
		return ok(c, { container_status: ContainerStatus.Running });
	} catch (error) {
		return err(c, 'DOCKER_ERROR', `Failed to start container: ${(error as Error).message}`, 500);
	}
});

projectsRoutes.post('/companies/:companyId/projects/:projectId/container/stop', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const projectId = await resolveProjectId(db, companyId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const result = await db.query<{ container_id: string | null; container_status: string | null }>(
		'SELECT container_id, container_status FROM projects WHERE id = $1 AND company_id = $2',
		[projectId, companyId],
	);
	if (result.rows.length === 0) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const row = result.rows[0];

	if (!row.container_id) {
		// No container yet (e.g. still provisioning) — just set status to stopped
		await db.query('UPDATE projects SET container_status = $1::container_status WHERE id = $2', [
			ContainerStatus.Stopped,
			projectId,
		]);
		broadcastChange(c, `company:${companyId}`, 'projects', 'UPDATE', {
			id: projectId,
			container_status: ContainerStatus.Stopped,
		});
		return ok(c, { container_status: ContainerStatus.Stopped });
	}

	await db.query('UPDATE projects SET container_status = $1::container_status WHERE id = $2', [
		ContainerStatus.Stopping,
		projectId,
	]);
	broadcastChange(c, `company:${companyId}`, 'projects', 'UPDATE', {
		id: projectId,
		container_status: ContainerStatus.Stopping,
	});

	const docker = c.get('docker');
	const wsManager = c.get('wsManager');
	const jobManager = c.get('jobManager');

	await cancelRunningAgentTasks(db, jobManager, projectId, companyId);

	const taskKey = `stop:${projectId}`;
	jobManager.launchTask(
		taskKey,
		async () => {
			await stopContainerGracefully(db, docker, projectId, row.container_id!, wsManager, companyId);
		},
		60_000,
	);

	return ok(c, { container_status: ContainerStatus.Stopping });
});

const REBUILD_TIMEOUT_MS = 5 * 60 * 1000;

projectsRoutes.post('/companies/:companyId/projects/:projectId/container/rebuild', async (c) => {
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

	const jobManager = c.get('jobManager');
	const taskKey = `rebuild:${projectId}`;

	// Cancel any conflicting tasks before launching rebuild
	jobManager.cancelTask(`stop:${projectId}`);
	jobManager.cancelTask(taskKey);
	await cancelRunningAgentTasks(db, jobManager, projectId, companyId);

	const docker = c.get('docker');
	const dataDir = c.get('dataDir');
	const wsManager = c.get('wsManager');

	await db.query('UPDATE projects SET container_status = $1::container_status WHERE id = $2', [
		ContainerStatus.Creating,
		projectId,
	]);

	broadcastChange(c, `company:${companyId}`, 'projects', 'UPDATE', {
		id: projectId,
		container_status: ContainerStatus.Creating,
	});

	jobManager.launchTask(
		taskKey,
		async () => {
			try {
				await rebuildContainer(
					db,
					docker,
					projectResult.rows[0] as ProjectRow,
					companySlug,
					dataDir,
					wsManager,
					companyId,
				);
				wakeAgentsWithPendingWork(db, projectId, companyId);
			} catch (error) {
				console.error(`Container rebuild failed for project ${projectId}:`, error);
			}
		},
		REBUILD_TIMEOUT_MS,
	);

	return ok(c, { container_status: ContainerStatus.Creating });
});
