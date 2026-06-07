import type { PGlite } from '@electric-sql/pglite';
import { AuthType, ContainerStatus, WakeupSource, wsRoom } from '@hezo/shared';
import { type Context, Hono } from 'hono';
import { trackBackground } from '../lib/background';
import { broadcastChange } from '../lib/broadcast';
import { ref } from '../lib/log-ref';
import { requireResourceInTeam } from '../lib/resource';
import { err, ok } from '../lib/response';
import { toProjectTaskPrefix, toSlug, uniqueSlug } from '../lib/slug';
import { terminalStatusParams } from '../lib/sql';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { requireSuperuser } from '../middleware/auth';
import {
	type ContainerDeps,
	type ProjectRow,
	provisionContainer,
	rebuildContainer,
	stopContainerGracefully,
	teardownContainer,
} from '../services/containers';
import type { JobManager } from '../services/job-manager';
import { createProjectIntake } from '../services/project-intake';
import { createTeam } from '../services/teams';
import { createWakeup } from '../services/wakeup';

function buildContainerDeps(c: Context<Env>): ContainerDeps {
	return {
		db: c.get('db'),
		docker: c.get('docker'),
		dataDir: c.get('dataDir'),
		wsManager: c.get('wsManager'),
		masterKeyManager: c.get('masterKeyManager'),
		logs: c.get('logs'),
		containerLogStreamer: c.get('containerLogStreamer'),
		sshAgentServer: c.get('sshAgentServer'),
		egressCAPath: c.get('egressProxy')?.caCertPath ?? null,
	};
}

const log = logger.child('routes');

async function cancelRunningAgentTasks(
	db: PGlite,
	jobManager: JobManager,
	projectId: string,
	teamId: string,
): Promise<void> {
	const running = await db.query<{ assignee_id: string }>(
		`SELECT DISTINCT i.assignee_id
		 FROM tasks i
		 JOIN execution_locks el ON el.task_id = i.id AND el.released_at IS NULL
		 WHERE i.project_id = $1 AND i.team_id = $2 AND i.assignee_id IS NOT NULL`,
		[projectId, teamId],
	);
	for (const row of running.rows) {
		jobManager.cancelTask(wsRoom.agent(row.assignee_id));
	}
}

async function wakeAgentsWithPendingWork(
	db: PGlite,
	projectId: string,
	teamId: string,
): Promise<void> {
	const { placeholders, values } = terminalStatusParams(3);
	const pending = await db.query<{ agent_id: string }>(
		`SELECT DISTINCT i.assignee_id AS agent_id
		 FROM tasks i
		 JOIN member_agents ma ON ma.id = i.assignee_id
		 WHERE i.project_id = $1 AND i.team_id = $2
		   AND i.status NOT IN (${placeholders})
		   AND ma.admin_status = 'enabled'`,
		[projectId, teamId, ...values],
	);
	for (const row of pending.rows) {
		trackBackground(
			createWakeup(db, row.agent_id, teamId, WakeupSource.Automation, {
				trigger: 'container_start',
				project_id: projectId,
			}).catch((e) => log.error('Failed to create wakeup on container start:', e)),
		);
	}
}

export const TASK_PREFIX_SHAPE = /^[A-Z][A-Z0-9]{1,3}$/;

export type TaskPrefixResult =
	| { ok: true; prefix: string }
	| { ok: false; code: 'INVALID_REQUEST' | 'CONFLICT'; message: string; status: 400 | 409 };

export async function resolveProjectTaskPrefix(
	db: PGlite,
	teamId: string,
	provided: string | undefined,
	projectName: string,
): Promise<TaskPrefixResult> {
	if (provided?.trim()) {
		const candidate = provided.trim().toUpperCase();
		if (!TASK_PREFIX_SHAPE.test(candidate)) {
			return {
				ok: false,
				code: 'INVALID_REQUEST',
				message: 'task_prefix must be 2-4 uppercase alphanumeric characters starting with a letter',
				status: 400,
			};
		}
		const collision = await db.query(
			'SELECT 1 FROM projects WHERE team_id = $1 AND task_prefix = $2',
			[teamId, candidate],
		);
		if (collision.rows.length > 0) {
			return {
				ok: false,
				code: 'CONFLICT',
				message: `Task prefix '${candidate}' is already in use for this team`,
				status: 409,
			};
		}
		return { ok: true, prefix: candidate };
	}

	const base = toProjectTaskPrefix(projectName);
	const existing = await db.query<{ task_prefix: string }>(
		'SELECT task_prefix FROM projects WHERE team_id = $1 AND task_prefix LIKE $2',
		[teamId, `${base}%`],
	);
	const taken = new Set(existing.rows.map((r) => r.task_prefix));
	if (!taken.has(base)) return { ok: true, prefix: base };
	for (let n = 2; n < 1000; n++) {
		const candidate = `${base}${n}`;
		if (!TASK_PREFIX_SHAPE.test(candidate)) break;
		if (!taken.has(candidate)) return { ok: true, prefix: candidate };
	}
	return {
		ok: false,
		code: 'CONFLICT',
		message: `Unable to derive a unique task_prefix from '${projectName}'; supply one explicitly`,
		status: 409,
	};
}

export const projectsRoutes = new Hono<Env>();

// Instance-level project index: every project the caller can see across all
// their teams, including the per-team internal projects. Carries the backing
// team's slug/name so the client can resolve a project's team without a teamId
// in the URL. The single public list behind the project rail.
projectsRoutes.get('/projects', async (c) => {
	const db = c.get('db');
	const auth = c.get('auth');
	const isSuperuser = auth.type === AuthType.Admin && auth.isSuperuser;
	const isAdmin = auth.type === AuthType.Admin;

	const ts = terminalStatusParams(1);
	const params: unknown[] = [...ts.values];
	const base = `SELECT p.*, t.slug AS team_slug, t.name AS team_name,
       (SELECT count(*) FROM repos r WHERE r.project_id = p.id)::int AS repo_count,
       (SELECT count(*) FROM tasks i WHERE i.project_id = p.id AND i.status NOT IN (${ts.placeholders}))::int AS open_task_count
     FROM projects p
     JOIN teams t ON t.id = p.team_id`;

	let query: string;
	if (!isAdmin || isSuperuser) {
		query = `${base} ORDER BY p.created_at DESC`;
	} else {
		query = `${base}
     JOIN members m2 ON m2.team_id = p.team_id
     JOIN member_users mu ON mu.id = m2.id
     WHERE mu.user_id = $${params.length + 1}
     ORDER BY p.created_at DESC`;
		params.push(auth.userId);
	}

	const result = await db.query(query, params);
	return ok(c, result.rows);
});

// Projects-primary creation: a project owns its own team. "Create a project"
// provisions a fresh team (roster from the chosen type), named after the
// project, and opens the project intake in that team's Internal project — the
// new team's Captain runs intake/planning. See .dev/per-project-teams.md.
// Superuser-gated, like team creation (the Admin owns the instance roster).
projectsRoutes.post('/projects', async (c) => {
	const denied = requireSuperuser(c);
	if (denied) return denied;

	const db = c.get('db');
	const body = await c.req.json<{
		name: string;
		description?: string;
		template_id?: string;
		task_prefix?: string;
		initial_prd?: string;
	}>();

	if (!body.name?.trim()) return err(c, 'INVALID_REQUEST', 'name is required', 400);
	if (!body.description?.trim()) return err(c, 'INVALID_REQUEST', 'description is required', 400);

	// 1. Create the project's dedicated team (its roster), named after the project.
	const auth = c.get('auth');
	const team = await createTeam(
		{
			db,
			docker: c.get('docker'),
			dataDir: c.get('dataDir'),
			wsManager: c.get('wsManager'),
			masterKeyManager: c.get('masterKeyManager'),
			logs: c.get('logs'),
			egressCAPath: c.get('egressProxy')?.caCertPath ?? null,
		},
		{
			name: body.name.trim(),
			description: body.description.trim(),
			templateId: body.template_id,
			creatorUserId: auth.type === AuthType.Admin ? auth.userId : undefined,
		},
	);

	// 2. Open the project intake on the new team (its Captain runs intake/planning).
	const prefixResult = await resolveProjectTaskPrefix(db, team.id, body.task_prefix, body.name);
	if (!prefixResult.ok) return err(c, prefixResult.code, prefixResult.message, prefixResult.status);

	const intake = await createProjectIntake(
		db,
		team.id,
		{
			name: body.name.trim(),
			description: body.description.trim(),
			taskPrefix: prefixResult.prefix,
			initialPrd: body.initial_prd?.trim() || null,
		},
		c.get('wsManager'),
	);
	if (!intake) {
		return err(c, 'INTERNAL', 'New team is missing its Captain or Internal project', 500);
	}

	return ok(
		c,
		{
			team_id: team.id,
			team_slug: team.slug,
			intake_task_id: intake.intakeTaskId,
			intake_task_identifier: intake.intakeTaskIdentifier,
			project_slug: intake.projectSlug,
			approval_id: intake.approvalId,
		},
		201,
	);
});

// Add another project to the team backing :projectId (project-addressed escape
// hatch — the 1:1 model doesn't surface this, but tests and multi-project teams
// use it). Opens the intake on the resolved team's Internal project.
projectsRoutes.post('/projects/:projectId/projects', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');

	const body = await c.req.json<{
		name: string;
		description?: string;
		initial_prd?: string;
		task_prefix?: string;
	}>();

	if (!body.name?.trim()) {
		return err(c, 'INVALID_REQUEST', 'name is required', 400);
	}
	if (!body.description?.trim()) {
		return err(c, 'INVALID_REQUEST', 'description is required', 400);
	}

	const prefixResult = await resolveProjectTaskPrefix(db, teamId, body.task_prefix, body.name);
	if (!prefixResult.ok) return err(c, prefixResult.code, prefixResult.message, prefixResult.status);

	const intake = await createProjectIntake(
		db,
		teamId,
		{
			name: body.name.trim(),
			description: body.description.trim(),
			taskPrefix: prefixResult.prefix,
			initialPrd: body.initial_prd?.trim() || null,
		},
		c.get('wsManager'),
	);
	if (!intake) {
		return err(
			c,
			'INTERNAL',
			'Cannot open project intake — the team is missing its Captain or Internal project.',
			500,
		);
	}

	return ok(
		c,
		{
			intake_task_id: intake.intakeTaskId,
			intake_task_identifier: intake.intakeTaskIdentifier,
			project_slug: intake.projectSlug,
			approval_id: intake.approvalId,
		},
		201,
	);
});

projectsRoutes.get('/projects/:projectId', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const projectId = c.get('projectId') as string;
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const ts2 = terminalStatusParams(3);
	const result = await db.query(
		`SELECT p.*,
       (SELECT count(*) FROM repos r WHERE r.project_id = p.id)::int AS repo_count,
       (SELECT count(*) FROM tasks i WHERE i.project_id = p.id AND i.status NOT IN (${ts2.placeholders}))::int AS open_task_count
     FROM projects p
     WHERE p.id = $1 AND p.team_id = $2`,
		[projectId, teamId, ...ts2.values],
	);

	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Project not found', 404);
	}

	const repos = await db.query('SELECT * FROM repos WHERE project_id = $1 ORDER BY short_name', [
		projectId,
	]);

	return ok(c, { ...(result.rows[0] as Record<string, unknown>), repos: repos.rows });
});

projectsRoutes.patch('/projects/:projectId', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const projectId = c.get('projectId') as string;
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const existing = await requireResourceInTeam<{ id: string }>(c, 'projects', projectId, teamId, {
		resourceName: 'Project',
	});
	if (existing instanceof Response) return existing;

	const body = await c.req.json<{
		name?: string;
		description?: string;
		max_concurrent_runs?: number;
	}>();

	const sets: string[] = [];
	const params: unknown[] = [];
	let idx = 1;

	if (body.name?.trim()) {
		const newSlug = await uniqueSlug(toSlug(body.name), async (s) => {
			const r = await db.query('SELECT 1 FROM projects WHERE slug = $1 AND id != $2', [
				s,
				projectId,
			]);
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
	if (body.max_concurrent_runs !== undefined) {
		if (!Number.isInteger(body.max_concurrent_runs) || body.max_concurrent_runs < 1) {
			return err(c, 'INVALID_REQUEST', 'max_concurrent_runs must be an integer ≥ 1', 400);
		}
		sets.push(`max_concurrent_runs = $${idx}`);
		params.push(body.max_concurrent_runs);
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
		wsRoom.team(teamId),
		'projects',
		'UPDATE',
		result.rows[0] as Record<string, unknown>,
	);
	return ok(c, result.rows[0]);
});

projectsRoutes.delete('/projects/:projectId', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const projectId = c.get('projectId') as string;
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const existing = await requireResourceInTeam<{ id: string; slug: string; is_internal: boolean }>(
		c,
		'projects',
		projectId,
		teamId,
		{ columns: 'id, slug, is_internal', resourceName: 'Project' },
	);
	if (existing instanceof Response) return existing;
	if (existing.is_internal) {
		return err(c, 'FORBIDDEN', 'Cannot delete an internal project', 403);
	}

	const ts3 = terminalStatusParams(2);
	const openTasks = await db.query<{ count: number }>(
		`SELECT count(*)::int AS count FROM tasks WHERE project_id = $1 AND status NOT IN (${ts3.placeholders})`,
		[projectId, ...ts3.values],
	);
	if (openTasks.rows[0].count > 0) {
		return err(c, 'CONFLICT', 'Cannot delete project with open tasks', 409);
	}

	await trackBackground(
		teardownContainer(buildContainerDeps(c), projectId, teamId).catch((error) => {
			log.error(`Failed to teardown container for project ${existing.slug}:`, error);
		}),
	);

	await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
	broadcastChange(c, wsRoom.team(teamId), 'projects', 'DELETE', { id: projectId });
	return c.json({ data: null }, 200);
});

projectsRoutes.post('/projects/:projectId/container/start', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const projectId = c.get('projectId') as string;
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const result = await requireResourceInTeam<{ container_id: string | null }>(
		c,
		'projects',
		projectId,
		teamId,
		{ columns: 'container_id', resourceName: 'Project' },
	);
	if (result instanceof Response) return result;
	if (!result.container_id) return err(c, 'NO_CONTAINER', 'No container provisioned', 400);

	const docker = c.get('docker');
	const containerId = result.container_id;
	try {
		await docker.startContainer(containerId);
		await db.query('UPDATE projects SET container_status = $1::container_status WHERE id = $2', [
			ContainerStatus.Running,
			projectId,
		]);
		c.get('containerLogStreamer').subscribe(projectId, containerId, c.get('logs'), docker);
		broadcastChange(c, wsRoom.team(teamId), 'projects', 'UPDATE', {
			id: projectId,
			container_status: ContainerStatus.Running,
		});
		wakeAgentsWithPendingWork(db, projectId, teamId);
		return ok(c, { container_status: ContainerStatus.Running });
	} catch (error) {
		return err(c, 'DOCKER_ERROR', `Failed to start container: ${(error as Error).message}`, 500);
	}
});

projectsRoutes.post('/projects/:projectId/container/stop', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const projectId = c.get('projectId') as string;
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const row = await requireResourceInTeam<{
		container_id: string | null;
		container_status: string | null;
	}>(c, 'projects', projectId, teamId, {
		columns: 'container_id, container_status',
		resourceName: 'Project',
	});
	if (row instanceof Response) return row;

	if (!row.container_id) {
		// No container yet (e.g. still provisioning) — just set status to stopped
		await db.query('UPDATE projects SET container_status = $1::container_status WHERE id = $2', [
			ContainerStatus.Stopped,
			projectId,
		]);
		broadcastChange(c, wsRoom.team(teamId), 'projects', 'UPDATE', {
			id: projectId,
			container_status: ContainerStatus.Stopped,
		});
		return ok(c, { container_status: ContainerStatus.Stopped });
	}

	await db.query('UPDATE projects SET container_status = $1::container_status WHERE id = $2', [
		ContainerStatus.Stopping,
		projectId,
	]);
	broadcastChange(c, wsRoom.team(teamId), 'projects', 'UPDATE', {
		id: projectId,
		container_status: ContainerStatus.Stopping,
	});

	const jobManager = c.get('jobManager');
	const containerDeps = buildContainerDeps(c);

	await cancelRunningAgentTasks(db, jobManager, projectId, teamId);

	const containerId = row.container_id;
	if (!containerId) return ok(c, { container_status: ContainerStatus.Stopping });

	const taskKey = `stop:${projectId}`;
	jobManager.launchTask(
		taskKey,
		async () => {
			await stopContainerGracefully(containerDeps, projectId, teamId, containerId);
		},
		60_000,
	);

	return ok(c, { container_status: ContainerStatus.Stopping });
});

const REBUILD_TIMEOUT_MS = 5 * 60 * 1000;

projectsRoutes.post('/projects/:projectId/container/rebuild', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const projectId = c.get('projectId') as string;
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const projectResult = await db.query('SELECT * FROM projects WHERE id = $1 AND team_id = $2', [
		projectId,
		teamId,
	]);
	if (projectResult.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Project not found', 404);
	}

	const teamSlugResult = await db.query<{ slug: string }>('SELECT slug FROM teams WHERE id = $1', [
		teamId,
	]);
	const teamSlug = teamSlugResult.rows[0]?.slug;
	if (!teamSlug) {
		return err(c, 'NOT_FOUND', 'Team not found', 404);
	}

	const jobManager = c.get('jobManager');
	const taskKey = `rebuild:${projectId}`;

	// Cancel any conflicting tasks before launching rebuild
	jobManager.cancelTask(`stop:${projectId}`);
	jobManager.cancelTask(taskKey);
	await cancelRunningAgentTasks(db, jobManager, projectId, teamId);

	const containerDeps = buildContainerDeps(c);

	await db.query('UPDATE projects SET container_status = $1::container_status WHERE id = $2', [
		ContainerStatus.Creating,
		projectId,
	]);

	broadcastChange(c, wsRoom.team(teamId), 'projects', 'UPDATE', {
		id: projectId,
		container_status: ContainerStatus.Creating,
	});

	jobManager.launchTask(
		taskKey,
		async () => {
			try {
				await rebuildContainer(containerDeps, projectResult.rows[0] as ProjectRow, teamSlug);
				wakeAgentsWithPendingWork(db, projectId, teamId);
			} catch (error) {
				log.error(
					`Container rebuild failed for project ${ref((projectResult.rows[0] as ProjectRow).slug, projectId)}:`,
					error,
				);
			}
		},
		REBUILD_TIMEOUT_MS,
	);

	return ok(c, { container_status: ContainerStatus.Creating });
});
