import type { PGlite } from '@electric-sql/pglite';
import {
	AgentAdminStatus,
	ContainerStatus,
	IssuePriority,
	IssueStatus,
	WakeupSource,
} from '@hezo/shared';
import { type Context, Hono } from 'hono';
import { broadcastChange } from '../lib/broadcast';
import { resolveProjectId } from '../lib/resolve';
import { err, ok } from '../lib/response';
import { toSlug, uniqueSlug } from '../lib/slug';
import { terminalStatusParams } from '../lib/sql';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { requireCompanyAccess } from '../middleware/auth';
import {
	type ContainerDeps,
	type ProjectRow,
	provisionContainer,
	rebuildContainer,
	stopContainerGracefully,
	teardownContainer,
} from '../services/containers';
import type { JobManager } from '../services/job-manager';
import { createWakeup } from '../services/wakeup';

function buildContainerDeps(c: Context<Env>): ContainerDeps {
	return {
		db: c.get('db'),
		docker: c.get('docker'),
		dataDir: c.get('dataDir'),
		wsManager: c.get('wsManager'),
		masterKeyManager: c.get('masterKeyManager'),
		logs: c.get('logs'),
	};
}

const log = logger.child('routes');

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
		}).catch((e) => log.error('Failed to create wakeup on container start:', e));
	}
}

export const projectsRoutes = new Hono<Env>();

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

	const body = await c.req.json<{
		name: string;
		description?: string;
		docker_base_image?: string;
	}>();

	if (!body.name?.trim()) {
		return err(c, 'INVALID_REQUEST', 'name is required', 400);
	}
	if (!body.description?.trim()) {
		return err(c, 'INVALID_REQUEST', 'description is required', 400);
	}

	const companyMetaResult = await db.query<{ slug: string; issue_prefix: string }>(
		'SELECT slug, issue_prefix FROM companies WHERE id = $1',
		[companyId],
	);
	const companyMeta = companyMetaResult.rows[0];
	if (!companyMeta) {
		return err(c, 'NOT_FOUND', 'Company not found', 404);
	}

	const ceoResult = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.company_id = $1 AND ma.slug = 'ceo' AND ma.admin_status = $2::agent_admin_status
		 LIMIT 1`,
		[companyId, AgentAdminStatus.Enabled],
	);
	const ceoMemberId = ceoResult.rows[0]?.id;
	if (!ceoMemberId) {
		return err(
			c,
			'INTERNAL',
			'No enabled CEO found for this company. Re-enable the CEO agent before creating projects.',
			500,
		);
	}

	const slug = await uniqueSlug(toSlug(body.name), async (s) => {
		const r = await db.query('SELECT 1 FROM projects WHERE company_id = $1 AND slug = $2', [
			companyId,
			s,
		]);
		return r.rows.length > 0;
	});

	const projectName = body.name.trim();
	const projectDescription = body.description.trim();

	await db.query('BEGIN');
	let project: Record<string, unknown>;
	let planningIssue: Record<string, unknown>;
	try {
		const projectResult = await db.query(
			`INSERT INTO projects (company_id, name, slug, description, docker_base_image)
			 VALUES ($1, $2, $3, $4, $5)
			 RETURNING *`,
			[
				companyId,
				projectName,
				slug,
				projectDescription,
				body.docker_base_image ?? 'hezo/agent-base:latest',
			],
		);
		project = projectResult.rows[0] as Record<string, unknown>;

		const numberResult = await db.query<{ number: number }>(
			'SELECT next_issue_number($1) AS number',
			[companyId],
		);
		const issueNumber = numberResult.rows[0].number;
		const identifier = `${companyMeta.issue_prefix}-${issueNumber}`;

		const issueBody = `## Draft the execution plan for this new project

A new project has just been created. Please read the description below carefully and produce an execution plan.

### Project: ${projectName}

**Description**

${projectDescription}

### Your task

1. Read the description above. If anything is ambiguous, post a clarifying comment on this issue for the board.
2. Use \`list_agents\` / \`get_agent_system_prompt\` to recall who is on the team.
3. Break the work into 3-8 top-level milestones. Write a short scope note for each.
4. Post the plan as a comment on this issue, then create child issues with \`create_issue\` (using \`parent_issue_id\` on this issue) for the first milestone, assigning each to the right agent.
5. Move this issue to **done** once the first milestone's child issues have been created and assigned.

Container provisioning for this project is in progress. Focus on planning while the environment comes up — implementation agents can start work as soon as their tickets are ready.`;

		const issueResult = await db.query(
			`INSERT INTO issues (company_id, project_id, assignee_id, number, identifier,
			                     title, description, status, priority, labels)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::issue_status, $9::issue_priority, $10::jsonb)
			 RETURNING *`,
			[
				companyId,
				project.id,
				ceoMemberId,
				issueNumber,
				identifier,
				`Draft execution plan for "${projectName}"`,
				issueBody,
				IssueStatus.Open,
				IssuePriority.High,
				JSON.stringify(['planning']),
			],
		);
		planningIssue = issueResult.rows[0] as Record<string, unknown>;

		await db.query('COMMIT');
	} catch (e) {
		await db.query('ROLLBACK');
		throw e;
	}

	broadcastChange(c, `company:${companyId}`, 'projects', 'INSERT', project);
	broadcastChange(c, `company:${companyId}`, 'issues', 'INSERT', planningIssue);

	createWakeup(db, ceoMemberId, companyId, WakeupSource.Assignment, {
		issue_id: planningIssue.id,
	}).catch((e) => log.error('Failed to wake CEO for project planning:', e));

	provisionContainer(
		buildContainerDeps(c),
		project as unknown as ProjectRow,
		companyMeta.slug,
	).catch((error) => {
		log.error(`Failed to provision container for project ${project.slug}:`, error);
	});

	return ok(c, { ...project, planning_issue_id: planningIssue.id }, 201);
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
		description?: string;
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
	if (body.description !== undefined) {
		sets.push(`description = $${idx}`);
		params.push(body.description);
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
		await teardownContainer(
			buildContainerDeps(c),
			projectId,
			companySlug,
			existing.rows[0].slug,
		).catch((error) => {
			log.error(`Failed to teardown container for project ${existing.rows[0].slug}:`, error);
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

	const jobManager = c.get('jobManager');
	const containerDeps = buildContainerDeps(c);

	await cancelRunningAgentTasks(db, jobManager, projectId, companyId);

	const containerId = row.container_id;
	if (!containerId) return ok(c, { container_status: ContainerStatus.Stopping });

	const taskKey = `stop:${projectId}`;
	jobManager.launchTask(
		taskKey,
		async () => {
			await stopContainerGracefully(containerDeps, projectId, companyId, containerId);
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

	const containerDeps = buildContainerDeps(c);

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
				await rebuildContainer(containerDeps, projectResult.rows[0] as ProjectRow, companySlug);
				wakeAgentsWithPendingWork(db, projectId, companyId);
			} catch (error) {
				log.error(`Container rebuild failed for project ${projectId}:`, error);
			}
		},
		REBUILD_TIMEOUT_MS,
	);

	return ok(c, { container_status: ContainerStatus.Creating });
});
