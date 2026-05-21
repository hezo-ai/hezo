import type { PGlite } from '@electric-sql/pglite';
import {
	AgentAdminStatus,
	CAPTAIN_AGENT_SLUG,
	ContainerStatus,
	WakeupSource,
	wsRoom,
} from '@hezo/shared';
import { type Context, Hono } from 'hono';
import { broadcastChange } from '../lib/broadcast';
import { resolveProjectId } from '../lib/resolve';
import { err, ok } from '../lib/response';
import { toProjectIssuePrefix, toSlug, uniqueSlug } from '../lib/slug';
import { terminalStatusParams } from '../lib/sql';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { requireTeamAccess } from '../middleware/auth';
import {
	type ContainerDeps,
	type ProjectRow,
	provisionContainer,
	rebuildContainer,
	stopContainerGracefully,
	teardownContainer,
} from '../services/containers';
import type { JobManager } from '../services/job-manager';
import { createProjectWithPlanningIssue } from '../services/project-create';
import { createWakeup } from '../services/wakeup';

function buildContainerDeps(c: Context<Env>): ContainerDeps {
	return {
		db: c.get('db'),
		docker: c.get('docker'),
		dataDir: c.get('dataDir'),
		wsManager: c.get('wsManager'),
		masterKeyManager: c.get('masterKeyManager'),
		logs: c.get('logs'),
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
		 FROM issues i
		 JOIN execution_locks el ON el.issue_id = i.id AND el.released_at IS NULL
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
		 FROM issues i
		 JOIN member_agents ma ON ma.id = i.assignee_id
		 WHERE i.project_id = $1 AND i.team_id = $2
		   AND i.status NOT IN (${placeholders})
		   AND ma.admin_status = 'enabled'`,
		[projectId, teamId, ...values],
	);
	for (const row of pending.rows) {
		createWakeup(db, row.agent_id, teamId, WakeupSource.Automation, {
			trigger: 'container_start',
			project_id: projectId,
		}).catch((e) => log.error('Failed to create wakeup on container start:', e));
	}
}

export const ISSUE_PREFIX_SHAPE = /^[A-Z][A-Z0-9]{1,3}$/;

export type IssuePrefixResult =
	| { ok: true; prefix: string }
	| { ok: false; code: 'INVALID_REQUEST' | 'CONFLICT'; message: string; status: 400 | 409 };

export async function resolveProjectIssuePrefix(
	db: PGlite,
	teamId: string,
	provided: string | undefined,
	projectName: string,
): Promise<IssuePrefixResult> {
	if (provided?.trim()) {
		const candidate = provided.trim().toUpperCase();
		if (!ISSUE_PREFIX_SHAPE.test(candidate)) {
			return {
				ok: false,
				code: 'INVALID_REQUEST',
				message:
					'issue_prefix must be 2-4 uppercase alphanumeric characters starting with a letter',
				status: 400,
			};
		}
		const collision = await db.query(
			'SELECT 1 FROM projects WHERE team_id = $1 AND issue_prefix = $2',
			[teamId, candidate],
		);
		if (collision.rows.length > 0) {
			return {
				ok: false,
				code: 'CONFLICT',
				message: `Issue prefix '${candidate}' is already in use for this team`,
				status: 409,
			};
		}
		return { ok: true, prefix: candidate };
	}

	const base = toProjectIssuePrefix(projectName);
	const existing = await db.query<{ issue_prefix: string }>(
		'SELECT issue_prefix FROM projects WHERE team_id = $1 AND issue_prefix LIKE $2',
		[teamId, `${base}%`],
	);
	const taken = new Set(existing.rows.map((r) => r.issue_prefix));
	if (!taken.has(base)) return { ok: true, prefix: base };
	for (let n = 2; n < 1000; n++) {
		const candidate = `${base}${n}`;
		if (!ISSUE_PREFIX_SHAPE.test(candidate)) break;
		if (!taken.has(candidate)) return { ok: true, prefix: candidate };
	}
	return {
		ok: false,
		code: 'CONFLICT',
		message: `Unable to derive a unique issue_prefix from '${projectName}'; supply one explicitly`,
		status: 409,
	};
}

export const projectsRoutes = new Hono<Env>();

projectsRoutes.get('/teams/:teamId/projects', async (c) => {
	const access = await requireTeamAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { teamId } = access;

	const ts = terminalStatusParams(2);
	const result = await db.query(
		`SELECT p.*,
       (SELECT count(*) FROM repos r WHERE r.project_id = p.id)::int AS repo_count,
       (SELECT count(*) FROM issues i WHERE i.project_id = p.id AND i.status NOT IN (${ts.placeholders}))::int AS open_issue_count
     FROM projects p
     WHERE p.team_id = $1
     ORDER BY p.created_at DESC`,
		[teamId, ...ts.values],
	);
	return ok(c, result.rows);
});

projectsRoutes.post('/teams/:teamId/projects', async (c) => {
	const access = await requireTeamAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { teamId } = access;

	const body = await c.req.json<{
		name: string;
		description?: string;
		docker_base_image?: string;
		initial_prd?: string;
		issue_prefix?: string;
	}>();

	if (!body.name?.trim()) {
		return err(c, 'INVALID_REQUEST', 'name is required', 400);
	}
	if (!body.description?.trim()) {
		return err(c, 'INVALID_REQUEST', 'description is required', 400);
	}

	const teamMetaResult = await db.query<{ slug: string }>('SELECT slug FROM teams WHERE id = $1', [
		teamId,
	]);
	const teamMeta = teamMetaResult.rows[0];
	if (!teamMeta) {
		return err(c, 'NOT_FOUND', 'Team not found', 404);
	}

	const prefixResult = await resolveProjectIssuePrefix(db, teamId, body.issue_prefix, body.name);
	if (!prefixResult.ok) return err(c, prefixResult.code, prefixResult.message, prefixResult.status);
	const issuePrefix = prefixResult.prefix;

	const captainResult = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = $3 AND ma.admin_status = $2::agent_admin_status
		 LIMIT 1`,
		[teamId, AgentAdminStatus.Enabled, CAPTAIN_AGENT_SLUG],
	);
	const captainMemberId = captainResult.rows[0]?.id;
	if (!captainMemberId) {
		return err(
			c,
			'INTERNAL',
			'No enabled Captain found for this team. Re-enable the Captain agent before creating projects.',
			500,
		);
	}

	const slug = await uniqueSlug(toSlug(body.name), async (s) => {
		const r = await db.query('SELECT 1 FROM projects WHERE team_id = $1 AND slug = $2', [
			teamId,
			s,
		]);
		return r.rows.length > 0;
	});

	const { project, planningIssue, deferCaptainPlanningWake } = await createProjectWithPlanningIssue(
		db,
		{
			teamId,
			captainMemberId,
			name: body.name.trim(),
			slug,
			issuePrefix,
			description: body.description.trim(),
			dockerBaseImage: body.docker_base_image,
			initialPrd: body.initial_prd?.trim() || null,
		},
	);

	broadcastChange(c, wsRoom.team(teamId), 'projects', 'INSERT', project);
	broadcastChange(c, wsRoom.team(teamId), 'issues', 'INSERT', planningIssue);

	if (!deferCaptainPlanningWake) {
		createWakeup(db, captainMemberId, teamId, WakeupSource.Assignment, {
			issue_id: planningIssue.id,
		}).catch((e) => log.error('Failed to wake Captain for project planning:', e));
	}

	provisionContainer(buildContainerDeps(c), project as unknown as ProjectRow, teamMeta.slug).catch(
		(error) => {
			log.error(`Failed to provision container for project ${project.slug}:`, error);
		},
	);

	return ok(
		c,
		{
			...project,
			planning_issue_id: planningIssue.id,
			planning_issue_identifier: planningIssue.identifier,
		},
		201,
	);
});

projectsRoutes.get('/teams/:teamId/projects/:projectId', async (c) => {
	const access = await requireTeamAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { teamId } = access;
	const projectId = await resolveProjectId(db, teamId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const ts2 = terminalStatusParams(3);
	const result = await db.query(
		`SELECT p.*,
       (SELECT count(*) FROM repos r WHERE r.project_id = p.id)::int AS repo_count,
       (SELECT count(*) FROM issues i WHERE i.project_id = p.id AND i.status NOT IN (${ts2.placeholders}))::int AS open_issue_count
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

projectsRoutes.patch('/teams/:teamId/projects/:projectId', async (c) => {
	const access = await requireTeamAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { teamId } = access;
	const projectId = await resolveProjectId(db, teamId, c.req.param('projectId'));
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
	}>();

	const sets: string[] = [];
	const params: unknown[] = [];
	let idx = 1;

	if (body.name?.trim()) {
		const newSlug = await uniqueSlug(toSlug(body.name), async (s) => {
			const r = await db.query(
				'SELECT 1 FROM projects WHERE team_id = $1 AND slug = $2 AND id != $3',
				[teamId, s, projectId],
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
		wsRoom.team(teamId),
		'projects',
		'UPDATE',
		result.rows[0] as Record<string, unknown>,
	);
	return ok(c, result.rows[0]);
});

projectsRoutes.delete('/teams/:teamId/projects/:projectId', async (c) => {
	const access = await requireTeamAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { teamId } = access;
	const projectId = await resolveProjectId(db, teamId, c.req.param('projectId'));
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
	const openIssues = await db.query<{ count: number }>(
		`SELECT count(*)::int AS count FROM issues WHERE project_id = $1 AND status NOT IN (${ts3.placeholders})`,
		[projectId, ...ts3.values],
	);
	if (openIssues.rows[0].count > 0) {
		return err(c, 'CONFLICT', 'Cannot delete project with open issues', 409);
	}

	const teamSlugResult = await db.query<{ slug: string }>('SELECT slug FROM teams WHERE id = $1', [
		teamId,
	]);
	const teamSlug = teamSlugResult.rows[0]?.slug;

	if (teamSlug) {
		await teardownContainer(
			buildContainerDeps(c),
			projectId,
			teamSlug,
			existing.rows[0].slug,
		).catch((error) => {
			log.error(`Failed to teardown container for project ${existing.rows[0].slug}:`, error);
		});
	}

	await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
	broadcastChange(c, wsRoom.team(teamId), 'projects', 'DELETE', { id: projectId });
	return c.json({ data: null }, 200);
});

projectsRoutes.post('/teams/:teamId/projects/:projectId/container/start', async (c) => {
	const access = await requireTeamAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { teamId } = access;
	const projectId = await resolveProjectId(db, teamId, c.req.param('projectId'));
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const result = await db.query<{ container_id: string | null }>(
		'SELECT container_id FROM projects WHERE id = $1 AND team_id = $2',
		[projectId, teamId],
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

projectsRoutes.post('/teams/:teamId/projects/:projectId/container/stop', async (c) => {
	const access = await requireTeamAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { teamId } = access;
	const projectId = await resolveProjectId(db, teamId, c.req.param('projectId'));
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

projectsRoutes.post('/teams/:teamId/projects/:projectId/container/rebuild', async (c) => {
	const access = await requireTeamAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { teamId } = access;
	const projectId = await resolveProjectId(db, teamId, c.req.param('projectId'));
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
				log.error(`Container rebuild failed for project ${projectId}:`, error);
			}
		},
		REBUILD_TIMEOUT_MS,
	);

	return ok(c, { container_status: ContainerStatus.Creating });
});
