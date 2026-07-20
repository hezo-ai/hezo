import {
	ArchiveFilter,
	AuthType,
	ContainerStatus,
	isAllowedProjectIconStoredMime,
	isArchiveFilter,
	MemberType,
	PROJECT_ICON_MAX_BYTES,
	PROJECT_ICON_MAX_DIMENSION,
	wsRoom,
} from '@hezo/shared';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Db } from '../db/database';
import { trackBackground } from '../lib/background';
import { broadcastChange, broadcastProjectUpdate } from '../lib/broadcast';
import { budgetWindowsError } from '../lib/budget-validation';
import { signEntityIconUrl } from '../lib/entity-icon-urls';
import { readImageDimensions } from '../lib/image-dimensions';
import { ref } from '../lib/log-ref';
import { signProjectIconUrl, verifyProjectIconUrl } from '../lib/project-icon-urls';
import { err, ok } from '../lib/response';
import { toSlug, uniqueSlug } from '../lib/slug';
import { terminalStatusParams } from '../lib/sql';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { requireAdminEquivalent, requireSuperuser } from '../middleware/auth';
import {
	type ContainerDeps,
	type ProjectRow,
	rebuildContainer,
	stopContainerGracefully,
	teardownContainer,
	wakeAgentsWithPendingWork,
} from '../services/containers';
import { loadCoordinationContext } from '../services/internal-intake';
import type { JobManager } from '../services/job-manager';
import { getMarketplaceTeam } from '../services/marketplace';
import { enqueueAddMarketplaceTeamTask } from '../services/marketplace-add-team';
import { createProjectWithTeam } from '../services/project-create';
import { getProjectDashboard } from '../services/project-dashboard';
import { createProjectIntake, getOpenProjectIntakeForHome } from '../services/project-intake';
import { getProjectProgress } from '../services/projects';

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

/**
 * Attach a freshly-signed `icon_url` to a serialized project row when it has an
 * icon (`icon_updated_at` is present from a LEFT-correlated subselect against
 * `project_icons`). The icon bytes themselves are never selected onto the row.
 */
async function withIconUrl(
	c: Context<Env>,
	row: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const updatedAt = row.icon_updated_at;
	if (typeof updatedAt === 'string' || updatedAt instanceof Date) {
		const version = Math.floor(new Date(updatedAt).getTime() / 1000);
		row.icon_url = await signProjectIconUrl(row.id as string, c.get('masterKeyManager'), version);
	} else {
		row.icon_url = null;
		row.icon_updated_at = null;
	}
	return row;
}

async function cancelRunningAgentTasks(
	db: Db,
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

	// Archive filter (default: active only — the rail hides archived projects).
	// `archived` backs the global-settings "Archived projects" page; `all` is
	// an escape hatch. The condition carries no params (literal IS [NOT] NULL),
	// so it can be spliced in without disturbing the positional param indices.
	const filterParam = c.req.query('filter');
	const filter: ArchiveFilter = isArchiveFilter(filterParam) ? filterParam : ArchiveFilter.Active;
	const archivedCond =
		filter === ArchiveFilter.Active
			? 'p.archived_at IS NULL'
			: filter === ArchiveFilter.Archived
				? 'p.archived_at IS NOT NULL'
				: null;

	const ts = terminalStatusParams(1);
	const agentTypeIdx = ts.values.length + 1;
	const params: unknown[] = [...ts.values, MemberType.Agent];
	const base = `SELECT p.*, t.slug AS team_slug, t.name AS team_name,
       (SELECT count(*) FROM members m WHERE m.team_id = p.team_id AND m.member_type = $${agentTypeIdx})::int AS agent_count,
       (SELECT count(*) FROM repos r WHERE r.project_id = p.id)::int AS repo_count,
       (SELECT count(*) FROM tasks i WHERE i.project_id = p.id AND i.status NOT IN (${ts.placeholders}))::int AS open_task_count,
       (SELECT count(*) FROM goals g WHERE g.project_id = p.id AND g.archived_at IS NULL)::int AS open_goal_count,
       (SELECT count(*) FROM member_agents ma JOIN members mm ON mm.id = ma.id
          WHERE mm.team_id = p.team_id AND ma.runtime_status = 'active'::agent_runtime_status)::int
          AS running_agents_count,
       (SELECT COALESCE(sum(ce.amount_cents), 0) FROM cost_entries ce
          WHERE ce.project_id = p.id AND ce.created_at >= date_trunc('day', now()))::int
          AS today_spend_cents,
       COALESCE((SELECT max(i3.updated_at) FROM tasks i3 WHERE i3.project_id = p.id), p.created_at)
          AS last_activity_at,
       (SELECT pi.updated_at FROM project_icons pi WHERE pi.project_id = p.id) AS icon_updated_at
     FROM projects p
     JOIN teams t ON t.id = p.team_id`;

	let query: string;
	if (!isAdmin || isSuperuser) {
		const where = archivedCond ? ` WHERE ${archivedCond}` : '';
		query = `${base}${where} ORDER BY p.created_at DESC`;
	} else {
		const and = archivedCond ? ` AND ${archivedCond}` : '';
		query = `${base}
     JOIN members m2 ON m2.team_id = p.team_id
     JOIN member_users mu ON mu.id = m2.id
     WHERE mu.user_id = $${params.length + 1}${and}
     ORDER BY p.created_at DESC`;
		params.push(auth.userId);
	}

	const result = await db.query(query, params);
	const rows = await Promise.all(
		result.rows.map((r) => withIconUrl(c, r as Record<string, unknown>)),
	);
	return ok(c, rows);
});

// Projects-primary creation: a project owns its own team (1:1). "Create a
// project" provisions a fresh team (roster from the chosen team-type template),
// then directly creates the project, its planning task, and an initial CEO
// coherence/setup task that the planning task is blocked on. The separate
// CEO-assisted flow (project intake) is used when the operator wants the CEO to
// help shape the project first. See .dev/architecture.md.
// Superuser-gated, like team creation (the Admin owns the instance roster).
projectsRoutes.post('/projects', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;

	const body = await c.req.json<{
		name: string;
		description?: string;
		template_id?: string;
		source_team_id?: string;
		marketplace_slug?: string;
		task_prefix?: string;
		initial_project_plan?: string;
		docker_base_image?: string;
	}>();

	if (!body.name?.trim()) return err(c, 'INVALID_REQUEST', 'name is required', 400);
	if (!body.description?.trim()) return err(c, 'INVALID_REQUEST', 'description is required', 400);

	const auth = c.get('auth');
	const result = await createProjectWithTeam(
		buildContainerDeps(c),
		{
			name: body.name.trim(),
			description: body.description.trim(),
			templateId: body.template_id,
			sourceTeamId: body.source_team_id,
			marketplaceSlug: body.marketplace_slug,
			taskPrefix: body.task_prefix,
			initialProjectPlan: body.initial_project_plan?.trim() || null,
			dockerBaseImage: body.docker_base_image,
			creatorUserId: auth.type === AuthType.Admin ? auth.userId : undefined,
			actorType: 'admin',
			// Non-superuser admins are audited as the actor; superusers/agents stay null.
			actorUserId: auth.type === AuthType.Admin && !auth.isSuperuser ? auth.userId : undefined,
		},
		{ events: c.get('events') },
	);
	if (!result.ok) return err(c, result.code, result.message, result.status);

	const { project, planningTask, team } = result;
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

// Add a marketplace team's roster to an EXISTING project's team. Rather than
// provisioning silently, this kicks off one CEO task in the project that fetches
// the team, auto-hires its members (via the apply_marketplace_team tool — the admin
// already opted in, so no per-hire approval), and reconciles the merged roster in
// the same run. Admin-gated; project-scoped middleware resolves the team.
projectsRoutes.post('/projects/:projectId/marketplace-team', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;

	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const body = await c.req.json<{ slug?: string }>();
	const slug = body.slug?.trim();
	if (!slug) return err(c, 'INVALID_REQUEST', 'slug is required', 400);

	const teamDef = await getMarketplaceTeam(slug);
	if (!teamDef) return err(c, 'NOT_FOUND', `Marketplace team "${slug}" not found`, 404);

	const result = await enqueueAddMarketplaceTeamTask(db, teamId, teamDef);
	if (!result) {
		return err(c, 'CONFLICT', 'This project cannot receive a team (no CEO or project found)', 409);
	}
	return ok(c, result, 201);
});

// CEO-assisted project creation: open a conversation in HQ where the CEO scopes
// the work with the admin. Nothing is created up front — no team, no project, no
// approval; the admin's chosen team type is recorded only as the CEO's baseline.
// On the admin's in-thread go-ahead the CEO creates the project + team itself via
// the create_project tool. Both the first-run welcome and the ongoing "new
// project with the CEO" flow post here.
projectsRoutes.post('/project-intakes', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;

	const db = c.get('db');
	const body = await c.req.json<{
		name: string;
		description?: string;
		template_id?: string;
		source_team_id?: string;
		marketplace_slug?: string;
		initial_project_plan?: string;
	}>();

	if (!body.name?.trim()) return err(c, 'INVALID_REQUEST', 'name is required', 400);
	if (!body.description?.trim()) return err(c, 'INVALID_REQUEST', 'description is required', 400);

	// The intake conversation lives in HQ and is run by the CEO.
	if (!(await loadCoordinationContext(db))) {
		return err(c, 'INTERNAL', 'HQ coordination project is not available', 500);
	}

	// Record the chosen team type as the CEO's baseline suggestion — without
	// creating anything (no team, no snapshot). The team + project are created
	// later by the CEO's create_project tool, once the admin approves in-thread.
	const templateId = body.template_id?.trim() || undefined;
	const sourceTeamId = body.source_team_id?.trim() || undefined;
	const marketplaceSlug = body.marketplace_slug?.trim() || undefined;
	if ([templateId, sourceTeamId, marketplaceSlug].filter(Boolean).length > 1) {
		return err(
			c,
			'INVALID_REQUEST',
			'Provide only one of template_id, source_team_id, or marketplace_slug',
			400,
		);
	}

	let baselineTeamTypeName: string | undefined;
	if (marketplaceSlug) {
		const def = await getMarketplaceTeam(marketplaceSlug);
		if (!def) return err(c, 'NOT_FOUND', `Marketplace team "${marketplaceSlug}" not found`, 404);
		baselineTeamTypeName = def.name;
	} else if (templateId) {
		const tpl = await db.query<{ name: string }>('SELECT name FROM team_templates WHERE id = $1', [
			templateId,
		]);
		if (tpl.rows.length === 0) return err(c, 'NOT_FOUND', 'Team template not found', 404);
		baselineTeamTypeName = tpl.rows[0].name;
	} else if (sourceTeamId) {
		const t = await db.query<{ name: string; is_internal: boolean }>(
			`SELECT t.name,
			        EXISTS (SELECT 1 FROM projects p WHERE p.team_id = t.id AND p.is_internal = true) AS is_internal
			 FROM teams t WHERE t.id = $1`,
			[sourceTeamId],
		);
		if (t.rows.length === 0) return err(c, 'NOT_FOUND', 'Source team not found', 404);
		if (t.rows[0].is_internal) {
			return err(c, 'INVALID_REQUEST', 'The HQ team cannot be used as a source team', 400);
		}
		baselineTeamTypeName = t.rows[0].name;
	} else {
		baselineTeamTypeName = 'Blank';
	}

	const intake = await createProjectIntake(
		db,
		{
			name: body.name.trim(),
			description: body.description.trim(),
			initialProjectPlan: body.initial_project_plan?.trim() || null,
			baselineTemplateId: templateId,
			baselineSourceTeamId: sourceTeamId,
			baselineMarketplaceSlug: marketplaceSlug,
			baselineTeamTypeName,
		},
		c.get('wsManager'),
	);
	if (!intake) return err(c, 'INTERNAL', 'Failed to open project intake', 500);

	return ok(
		c,
		{
			intake_task_id: intake.intakeTaskId,
			intake_task_identifier: intake.intakeTaskIdentifier,
			project_slug: intake.projectSlug,
		},
		201,
	);
});

// The single open project-intake conversation for the welcome/home view.
projectsRoutes.get('/project-intakes', async (c) => {
	const denied = requireAdminEquivalent(c);
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
       (SELECT count(*) FROM tasks i WHERE i.project_id = p.id AND i.status NOT IN (${ts2.placeholders}))::int AS open_task_count,
       (SELECT count(*) FROM goals g WHERE g.project_id = p.id AND g.archived_at IS NULL)::int AS open_goal_count,
       (SELECT pi.updated_at FROM project_icons pi WHERE pi.project_id = p.id) AS icon_updated_at
     FROM projects p
     WHERE p.id = $1 AND p.team_id = $2`,
		[projectId, teamId, ...ts2.values],
	);

	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Project not found', 404);
	}

	const repos = await db.query(
		`SELECT * FROM repos WHERE project_id = $1 ORDER BY split_part(repo_identifier, '/', 2)`,
		[projectId],
	);

	const row = await withIconUrl(c, result.rows[0] as Record<string, unknown>);
	return ok(c, { ...row, repos: repos.rows });
});

// The Captain-maintained progress summary shown at the top of the Progress page. Kept off the
// project index (which lists every project) so the potentially-long summary is fetched per page.
projectsRoutes.get('/projects/:projectId/progress', async (c) => {
	const projectId = c.get('projectId') as string;
	const progress = await getProjectProgress(c.get('db'), projectId);
	if (!progress) return err(c, 'NOT_FOUND', 'Project not found', 404);
	return ok(c, progress);
});

// Aggregated at-a-glance payload for the per-project Dashboard page.
projectsRoutes.get('/projects/:projectId/dashboard', async (c) => {
	const teamId = c.get('teamId') as string;
	const projectId = c.get('projectId') as string;
	const auth = c.get('auth');
	const adminUserId = auth.type === AuthType.Admin ? auth.userId : null;

	const signAgentIcon = async (agentId: string, iconUpdatedAt: string | null) => {
		if (!iconUpdatedAt) return null;
		const version = Math.floor(new Date(iconUpdatedAt).getTime() / 1000);
		return signEntityIconUrl(
			'/api/agents',
			'agent-icon-url',
			agentId,
			c.get('masterKeyManager'),
			version,
		);
	};

	const dashboard = await getProjectDashboard(
		c.get('db'),
		projectId,
		teamId,
		adminUserId,
		signAgentIcon,
	);
	if (!dashboard) return err(c, 'NOT_FOUND', 'Project not found', 404);
	return ok(c, dashboard);
});

projectsRoutes.patch('/projects/:projectId', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const projectId = c.get('projectId') as string;
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const existing = await db.query<{
		daily_budget_cents: number;
		weekly_budget_cents: number;
		monthly_budget_cents: number;
	}>(
		`SELECT daily_budget_cents, weekly_budget_cents, monthly_budget_cents
		 FROM projects WHERE id = $1 AND team_id = $2`,
		[projectId, teamId],
	);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Project not found', 404);
	}

	const body = await c.req.json<{
		name?: string;
		description?: string;
		max_concurrent_runs?: number;
		memory_limit_gib?: number;
		daily_budget_cents?: number;
		weekly_budget_cents?: number;
		monthly_budget_cents?: number;
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
	// Budget limits: 0 = unlimited. Validate the *merged* trio (incoming ?? stored)
	// since a PATCH may touch only one window — enforces both per-field integer ≥ 0
	// and the cross-window consistency rules (shared with the web forms).
	const budgetColumns = [
		'daily_budget_cents',
		'weekly_budget_cents',
		'monthly_budget_cents',
	] as const;
	if (budgetColumns.some((column) => body[column] !== undefined)) {
		const current = existing.rows[0];
		const merged = {
			daily_budget_cents: body.daily_budget_cents ?? current.daily_budget_cents,
			weekly_budget_cents: body.weekly_budget_cents ?? current.weekly_budget_cents,
			monthly_budget_cents: body.monthly_budget_cents ?? current.monthly_budget_cents,
		};
		const budgetError = budgetWindowsError(merged);
		if (budgetError) {
			return err(c, 'INVALID_REQUEST', budgetError, 400);
		}
		for (const column of budgetColumns) {
			if (body[column] === undefined) continue;
			sets.push(`${column} = $${idx}`);
			params.push(body[column]);
			idx++;
		}
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

// --- Archive / unarchive ------------------------------------------------------
// Soft-delete a project: it drops out of the default project index (the rail),
// keeping its row/tasks/history so it can be restored. Superuser-only, matching
// the global-settings "Archived projects" page that unarchives. Archiving also
// stops the container (a retired project is dormant); unarchiving restores
// visibility only — the container stays stopped, like any stopped project.
projectsRoutes.post('/projects/:projectId/archive', async (c) => {
	const denied = requireSuperuser(c);
	if (denied) return denied;

	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const projectId = c.get('projectId') as string;
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const existing = await db.query<{
		slug: string;
		is_internal: boolean;
		container_id: string | null;
	}>('SELECT slug, is_internal, container_id FROM projects WHERE id = $1 AND team_id = $2', [
		projectId,
		teamId,
	]);
	if (existing.rows.length === 0) return err(c, 'NOT_FOUND', 'Project not found', 404);
	if (existing.rows[0].is_internal) {
		return err(c, 'FORBIDDEN', 'Cannot archive an internal project', 403);
	}

	const { slug: projectSlug, container_id: containerId } = existing.rows[0];

	// Cancel in-flight agent runs before stopping the container (mirrors
	// POST /projects/:projectId/container/stop). No container yet → just mark it
	// stopped so the archived project reads as dormant.
	if (containerId) {
		await cancelRunningAgentTasks(db, c.get('jobManager'), projectId, teamId);
	}

	const result = await db.query(
		`UPDATE projects
		 SET archived_at = now(), container_status = $1::container_status
		 WHERE id = $2 RETURNING *`,
		[containerId ? ContainerStatus.Stopping : ContainerStatus.Stopped, projectId],
	);

	if (containerId) {
		const containerDeps = buildContainerDeps(c);
		c.get('jobManager').launchTask(
			`stop:${projectId}`,
			async () => {
				await stopContainerGracefully(containerDeps, projectId, projectSlug, teamId, containerId);
			},
			60_000,
		);
	}

	broadcastChange(
		c,
		wsRoom.team(teamId),
		'projects',
		'UPDATE',
		result.rows[0] as Record<string, unknown>,
	);
	log.info(`project ${ref(projectSlug, projectId)} archived`);
	return ok(c, result.rows[0]);
});

projectsRoutes.post('/projects/:projectId/unarchive', async (c) => {
	const denied = requireSuperuser(c);
	if (denied) return denied;

	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const projectId = c.get('projectId') as string;
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const result = await db.query(
		`UPDATE projects SET archived_at = NULL WHERE id = $1 AND team_id = $2 RETURNING *`,
		[projectId, teamId],
	);
	if (result.rows.length === 0) return err(c, 'NOT_FOUND', 'Project not found', 404);

	broadcastChange(
		c,
		wsRoom.team(teamId),
		'projects',
		'UPDATE',
		result.rows[0] as Record<string, unknown>,
	);
	return ok(c, result.rows[0]);
});

// --- Project icon -------------------------------------------------------------
// An optional user-uploaded image shown in the rail in place of the initials.
// Stored as bytes in the DB (project_icons, 1:1). The client normalizes any
// picked image to a square PNG ≤ PROJECT_ICON_MAX_DIMENSION before upload; the
// server re-validates content-type, byte size, and pixel dimensions defensively.

projectsRoutes.put(
	'/projects/:projectId/icon',
	bodyLimit({
		maxSize: PROJECT_ICON_MAX_BYTES,
		onError: (c) => err(c, 'TOO_LARGE', 'Icon exceeds the size limit', 400),
	}),
	async (c) => {
		const teamId = c.get('teamId') as string;
		const db = c.get('db');
		const projectId = c.get('projectId') as string;
		if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

		let form: Awaited<ReturnType<typeof c.req.parseBody>>;
		try {
			form = await c.req.parseBody({ all: false });
		} catch (e) {
			log.error('project icon parseBody failed:', e);
			return err(c, 'INVALID_REQUEST', 'Malformed upload', 400);
		}
		const file = form.file;
		if (!(file instanceof Blob)) {
			return err(c, 'INVALID_REQUEST', 'Missing file field', 400);
		}

		const contentType = file.type || 'application/octet-stream';
		if (!isAllowedProjectIconStoredMime(contentType)) {
			return err(c, 'INVALID_ATTACHMENT', `Unsupported content type: ${contentType}`, 400);
		}
		if (file.size > PROJECT_ICON_MAX_BYTES) {
			return err(c, 'TOO_LARGE', 'Icon exceeds the size limit', 400);
		}

		const buf = Buffer.from(await file.arrayBuffer());
		const dims = readImageDimensions(buf);
		if (!dims) {
			return err(c, 'INVALID_ATTACHMENT', 'Could not read image dimensions', 400);
		}
		if (dims.width > PROJECT_ICON_MAX_DIMENSION || dims.height > PROJECT_ICON_MAX_DIMENSION) {
			return err(
				c,
				'INVALID_ATTACHMENT',
				`Icon exceeds ${PROJECT_ICON_MAX_DIMENSION}×${PROJECT_ICON_MAX_DIMENSION} pixels`,
				400,
			);
		}

		const updated = await db.query<{ updated_at: string }>(
			`INSERT INTO project_icons (project_id, content_type, data, byte_size, width, height, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6, now())
			 ON CONFLICT (project_id) DO UPDATE SET
			   content_type = EXCLUDED.content_type,
			   data         = EXCLUDED.data,
			   byte_size    = EXCLUDED.byte_size,
			   width        = EXCLUDED.width,
			   height       = EXCLUDED.height,
			   updated_at   = now()
			 RETURNING updated_at`,
			[projectId, contentType, buf, buf.byteLength, dims.width, dims.height],
		);

		await broadcastProjectUpdate(db, c.get('wsManager'), teamId, projectId);

		const version = Math.floor(new Date(updated.rows[0].updated_at).getTime() / 1000);
		const iconUrl = await signProjectIconUrl(projectId, c.get('masterKeyManager'), version);
		return ok(c, { icon_url: iconUrl, icon_updated_at: updated.rows[0].updated_at });
	},
);

projectsRoutes.delete('/projects/:projectId/icon', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const projectId = c.get('projectId') as string;
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	await db.query('DELETE FROM project_icons WHERE project_id = $1', [projectId]);
	await broadcastProjectUpdate(db, c.get('wsManager'), teamId, projectId);
	return ok(c, { icon_url: null, icon_updated_at: null });
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
		teardownContainer(buildContainerDeps(c), projectId, existing.rows[0].slug, teamId).catch(
			(error) => {
				log.error(
					`Failed to teardown container for project ${ref(existing.rows[0].slug, projectId)}:`,
					error,
				);
			},
		),
	);

	// Blob removal is best-effort after the row delete below (the rows are the
	// source of truth). deleteProjectAssets also sweeps orphaned blobs whose
	// rows were already gone.
	await trackBackground(
		c
			.get('assetStore')
			.deleteProjectAssets(projectId)
			.catch((error) => {
				log.error(
					`Failed to delete asset blobs for project ${ref(existing.rows[0].slug, projectId)}:`,
					error,
				);
			}),
	);

	// Purge the project's OAuth connections + their vault secrets before the row
	// delete: the project_id cascade drops the connection rows but would orphan
	// their encrypted token secrets otherwise.
	const { deleteProjectConnections } = await import('../services/oauth/connection-store');
	await deleteProjectConnections({ db, masterKeyManager: c.get('masterKeyManager') }, projectId);

	await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
	broadcastChange(c, wsRoom.team(teamId), 'projects', 'DELETE', { id: projectId });
	return c.json({ data: null }, 200);
});

projectsRoutes.post('/projects/:projectId/container/start', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const projectId = c.get('projectId') as string;
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const result = await db.query<{ slug: string; container_id: string | null }>(
		'SELECT slug, container_id FROM projects WHERE id = $1 AND team_id = $2',
		[projectId, teamId],
	);
	if (result.rows.length === 0) return err(c, 'NOT_FOUND', 'Project not found', 404);
	if (!result.rows[0].container_id) return err(c, 'NO_CONTAINER', 'No container provisioned', 400);

	const docker = c.get('docker');
	const projectSlug = result.rows[0].slug;
	const containerId = result.rows[0].container_id;
	try {
		await docker.startContainer(containerId);
		await db.query('UPDATE projects SET container_status = $1::container_status WHERE id = $2', [
			ContainerStatus.Running,
			projectId,
		]);
		c.get('containerLogStreamer').subscribe(projectId, containerId, c.get('logs'), docker);
		await broadcastProjectUpdate(db, c.get('wsManager'), teamId, projectId);
		await wakeAgentsWithPendingWork(db, projectId, teamId);
		log.info(
			`project ${ref(projectSlug, projectId)} container ${ref(projectSlug, containerId.slice(0, 12))} started`,
		);
		return ok(c, { container_status: ContainerStatus.Running });
	} catch (error) {
		const message = (error as Error).message;
		log.warn(
			`project ${ref(projectSlug, projectId)} container ${ref(projectSlug, containerId.slice(0, 12))} start failed: ${message}`,
		);
		return err(c, 'DOCKER_ERROR', `Failed to start container: ${message}`, 500);
	}
});

projectsRoutes.post('/projects/:projectId/container/stop', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const projectId = c.get('projectId') as string;
	if (!projectId) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const result = await db.query<{
		slug: string;
		container_id: string | null;
		container_status: string | null;
	}>('SELECT slug, container_id, container_status FROM projects WHERE id = $1 AND team_id = $2', [
		projectId,
		teamId,
	]);
	if (result.rows.length === 0) return err(c, 'NOT_FOUND', 'Project not found', 404);

	const row = result.rows[0];

	if (!row.container_id) {
		// No container yet (e.g. still provisioning) — just set status to stopped
		await db.query('UPDATE projects SET container_status = $1::container_status WHERE id = $2', [
			ContainerStatus.Stopped,
			projectId,
		]);
		await broadcastProjectUpdate(db, c.get('wsManager'), teamId, projectId);
		return ok(c, { container_status: ContainerStatus.Stopped });
	}

	await db.query('UPDATE projects SET container_status = $1::container_status WHERE id = $2', [
		ContainerStatus.Stopping,
		projectId,
	]);
	await broadcastProjectUpdate(db, c.get('wsManager'), teamId, projectId);

	const jobManager = c.get('jobManager');
	const containerDeps = buildContainerDeps(c);

	await cancelRunningAgentTasks(db, jobManager, projectId, teamId);

	const containerId = row.container_id;
	if (!containerId) return ok(c, { container_status: ContainerStatus.Stopping });

	const projectSlug = row.slug;
	const taskKey = `stop:${projectId}`;
	jobManager.launchTask(
		taskKey,
		async () => {
			await stopContainerGracefully(containerDeps, projectId, projectSlug, teamId, containerId);
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

	const projectResult = await db.query<ProjectRow>(
		'SELECT * FROM projects WHERE id = $1 AND team_id = $2',
		[projectId, teamId],
	);
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

	await broadcastProjectUpdate(db, c.get('wsManager'), teamId, projectId);

	jobManager.launchTask(
		taskKey,
		async () => {
			try {
				await rebuildContainer(containerDeps, projectResult.rows[0], teamSlug);
				await wakeAgentsWithPendingWork(db, projectId, teamId);
			} catch (error) {
				log.error(
					`Container rebuild failed for project ${ref(projectResult.rows[0].slug, projectId)}:`,
					error,
				);
			}
		},
		REBUILD_TIMEOUT_MS,
	);

	return ok(c, { container_status: ContainerStatus.Creating });
});

// Public signed-URL read endpoint for a project icon. Rendered in an `<img>`
// tag, which can't carry a bearer token, so the HMAC `sig` query param is the
// credential. Must be mounted before the `/api/*` auth middleware.
export const publicProjectsRoutes = new Hono<Env>();

publicProjectsRoutes.get('/api/projects/:projectId/icon', async (c) => {
	const projectId = c.req.param('projectId');
	const expRaw = c.req.query('exp');
	const sig = c.req.query('sig');
	if (!expRaw || !sig) {
		return err(c, 'UNAUTHORIZED', 'Missing signature', 401);
	}
	const exp = Number.parseInt(expRaw, 10);
	const masterKeyManager = c.get('masterKeyManager');
	const valid = await verifyProjectIconUrl(projectId, exp, sig, masterKeyManager);
	if (!valid) {
		return err(c, 'UNAUTHORIZED', 'Invalid or expired signature', 401);
	}

	const row = await c.get('db').query<{
		content_type: string;
		data: Uint8Array;
		updated_at: string;
	}>('SELECT content_type, data, updated_at FROM project_icons WHERE project_id = $1', [projectId]);
	if (row.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Icon not found', 404);
	}
	const { content_type, data, updated_at } = row.rows[0];
	const src = data instanceof Uint8Array ? data : new Uint8Array(data);
	// Copy into a fresh ArrayBuffer so the body type is Uint8Array<ArrayBuffer>
	// (PGlite hands back a Uint8Array<ArrayBufferLike>).
	const ab = new ArrayBuffer(src.byteLength);
	new Uint8Array(ab).set(src);

	return c.body(new Uint8Array(ab), 200, {
		'Content-Type': content_type,
		'Content-Length': String(src.byteLength),
		'Cache-Control': 'private, max-age=3600',
		ETag: `"${new Date(updated_at).getTime()}"`,
	});
});
