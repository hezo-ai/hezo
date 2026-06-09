import type { PGlite } from '@electric-sql/pglite';
import {
	AgentAdminStatus,
	AuthType,
	CAPTAIN_AGENT_SLUG,
	ContainerStatus,
	WakeupSource,
	wsRoom,
} from '@hezo/shared';
import { type Context, Hono } from 'hono';
import { trackBackground } from '../lib/background';
import { broadcastChange } from '../lib/broadcast';
import { ref } from '../lib/log-ref';
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
	wakeAgentsWithPendingWork,
} from '../services/containers';
import { enqueueTeamCoherenceReviewTask } from '../services/description-tasks';
import { loadCoordinationContext } from '../services/internal-intake';
import type { JobManager } from '../services/job-manager';
import { createPlanningTask, createProject } from '../services/project-create';
import { createProjectIntake, getOpenProjectIntakeForHome } from '../services/project-intake';
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
// their teams, including the single HQ project. Carries the backing team's
// slug/name so the client can resolve a project's team without a teamId in the
// URL. The single public list behind the project rail.
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

// Projects-primary creation: a project owns its own team (1:1). "Create a
// project" provisions a fresh team (roster from the chosen team-type template),
// then directly creates the project, its planning task, and an initial CEO
// coherence/setup task that the planning task is blocked on. The separate
// CEO-assisted flow (project intake) is used when the operator wants the CEO to
// help shape the project first. See .dev/per-project-teams.md.
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
		docker_base_image?: string;
	}>();

	if (!body.name?.trim()) return err(c, 'INVALID_REQUEST', 'name is required', 400);
	if (!body.description?.trim()) return err(c, 'INVALID_REQUEST', 'description is required', 400);

	// A project is always created from a team-type template — the Blank template
	// (Captain only) when the caller doesn't choose one.
	let templateId = body.template_id;
	if (!templateId) {
		const blank = await db.query<{ id: string }>('SELECT id FROM team_templates WHERE name = $1', [
			'Blank',
		]);
		templateId = blank.rows[0]?.id;
	}

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
			templateId,
			creatorUserId: auth.type === AuthType.Admin ? auth.userId : undefined,
		},
	);

	const prefixResult = await resolveProjectTaskPrefix(db, team.id, body.task_prefix, body.name);
	if (!prefixResult.ok) return err(c, prefixResult.code, prefixResult.message, prefixResult.status);

	const captain = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = $3 AND ma.admin_status = $2::agent_admin_status`,
		[team.id, AgentAdminStatus.Enabled, CAPTAIN_AGENT_SLUG],
	);
	const captainMemberId = captain.rows[0]?.id;
	if (!captainMemberId) return err(c, 'INTERNAL', 'New team is missing its Captain', 500);

	const slug = await uniqueSlug(toSlug(body.name), async (s) => {
		const r = await db.query('SELECT 1 FROM projects WHERE slug = $1', [s]);
		return r.rows.length > 0;
	});

	const actorMemberId =
		auth.type === AuthType.Admin && !auth.isSuperuser
			? ((
					await db.query<{ id: string }>(
						`SELECT m.id FROM members m JOIN member_users mu ON mu.id = m.id
						 WHERE mu.user_id = $1 AND m.team_id = $2`,
						[auth.userId, team.id],
					)
				).rows[0]?.id ?? null)
			: null;

	const { project } = await createProject(db, {
		teamId: team.id,
		captainMemberId,
		name: body.name.trim(),
		slug,
		taskPrefix: prefixResult.prefix,
		description: body.description.trim(),
		initialPrd: body.initial_prd?.trim() || null,
		dockerBaseImage: body.docker_base_image,
		events: c.get('events'),
		actorType: 'admin',
		actorMemberId,
	});

	// The CEO's initial coherence/setup pass is the project's first ticket and
	// blocks planning, so it's created before the planning task to take TO-1.
	const coherenceTaskId = await enqueueTeamCoherenceReviewTask(db, team.id, 'initial');

	const { planningTask } = await createPlanningTask(db, {
		teamId: team.id,
		project,
		captainMemberId,
		name: body.name.trim(),
		description: body.description.trim(),
		initialPrd: body.initial_prd?.trim() || null,
	});

	const wsManager = c.get('wsManager');
	if (wsManager) {
		broadcastChange(c, wsRoom.team(team.id), 'projects', 'INSERT', project);
		broadcastChange(c, wsRoom.team(team.id), 'tasks', 'INSERT', planningTask);
	}

	if (coherenceTaskId) {
		await db.query(
			`INSERT INTO task_dependencies (task_id, blocked_by_task_id)
			 VALUES ($1, $2) ON CONFLICT DO NOTHING`,
			[planningTask.id, coherenceTaskId],
		);
	}

	trackBackground(
		createWakeup(db, captainMemberId, team.id, WakeupSource.Assignment, {
			task_id: planningTask.id as string,
		}).catch((e) => log.error('Failed to wake Captain for planning:', e)),
	);

	trackBackground(
		provisionContainer(buildContainerDeps(c), project as unknown as ProjectRow, team.slug).catch(
			(e) => log.error('Failed to provision container for new project:', e),
		),
	);

	return ok(
		c,
		{
			...project,
			team_slug: team.slug,
			planning_task_id: planningTask.id,
			planning_task_identifier: planningTask.identifier,
		},
		201,
	);
});

async function resolveTemplateId(db: PGlite, requested?: string): Promise<string | undefined> {
	if (requested) return requested;
	const blank = await db.query<{ id: string }>('SELECT id FROM team_templates WHERE name = $1', [
		'Blank',
	]);
	return blank.rows[0]?.id;
}

// CEO-assisted project creation: stand up the project's team up front, then open
// a conversation in HQ where the CEO scopes the work and asks the admin to
// approve. The project itself is created on approval. Both the first-run welcome
// and the ongoing "new project with the CEO" flow post here.
projectsRoutes.post('/project-intakes', async (c) => {
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

	// The intake conversation requires the CEO + HQ project. Verify before standing
	// up the team so a missing HQ doesn't leave an orphaned, projectless team behind.
	if (!(await loadCoordinationContext(db))) {
		return err(c, 'INTERNAL', 'HQ coordination project is not available', 500);
	}

	const templateId = await resolveTemplateId(db, body.template_id);
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
			templateId,
			creatorUserId: auth.type === AuthType.Admin ? auth.userId : undefined,
		},
	);

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
	if (!intake) return err(c, 'INTERNAL', 'Failed to open project intake', 500);

	return ok(
		c,
		{
			intake_task_id: intake.intakeTaskId,
			intake_task_identifier: intake.intakeTaskIdentifier,
			approval_id: intake.approvalId,
			project_slug: intake.projectSlug,
			team_id: team.id,
			team_slug: team.slug,
		},
		201,
	);
});

// The single open project-intake conversation for the welcome/home view.
projectsRoutes.get('/project-intakes', async (c) => {
	const denied = requireSuperuser(c);
	if (denied) return denied;
	const intake = await getOpenProjectIntakeForHome(c.get('db'));
	return ok(c, intake);
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

	const existing = await db.query('SELECT id FROM projects WHERE id = $1 AND team_id = $2', [
		projectId,
		teamId,
	]);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Project not found', 404);
	}

	const body = await c.req.json<{
		name?: string;
		description?: string;
		max_concurrent_runs?: number;
		memory_limit_gib?: number;
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
	if (body.memory_limit_gib !== undefined) {
		if (!Number.isInteger(body.memory_limit_gib) || body.memory_limit_gib < 1) {
			return err(c, 'INVALID_REQUEST', 'memory_limit_gib must be an integer ≥ 1', 400);
		}
		sets.push(`memory_limit_gib = $${idx}`);
		params.push(body.memory_limit_gib);
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

	const existing = await db.query<{ id: string; slug: string; is_internal: boolean }>(
		'SELECT id, slug, is_internal FROM projects WHERE id = $1 AND team_id = $2',
		[projectId, teamId],
	);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Project not found', 404);
	}
	if (existing.rows[0].is_internal) {
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
			log.error(`Failed to teardown container for project ${existing.rows[0].slug}:`, error);
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

	const result = await db.query<{ container_id: string | null }>(
		'SELECT container_id FROM projects WHERE id = $1 AND team_id = $2',
		[projectId, teamId],
	);
	if (result.rows.length === 0) return err(c, 'NOT_FOUND', 'Project not found', 404);
	if (!result.rows[0].container_id) return err(c, 'NO_CONTAINER', 'No container provisioned', 400);

	const docker = c.get('docker');
	const containerId = result.rows[0].container_id;
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
		log.info(`project ${projectId} container ${containerId.slice(0, 12)} started`);
		return ok(c, { container_status: ContainerStatus.Running });
	} catch (error) {
		const message = (error as Error).message;
		log.warn(`project ${projectId} container ${containerId.slice(0, 12)} start failed: ${message}`);
		return err(c, 'DOCKER_ERROR', `Failed to start container: ${message}`, 500);
	}
});

projectsRoutes.post('/projects/:projectId/container/stop', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const projectId = c.get('projectId') as string;
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const result = await db.query<{ container_id: string | null; container_status: string | null }>(
		'SELECT container_id, container_status FROM projects WHERE id = $1 AND team_id = $2',
		[projectId, teamId],
	);
	if (result.rows.length === 0) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const row = result.rows[0];

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
