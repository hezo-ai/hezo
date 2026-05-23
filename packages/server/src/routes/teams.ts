import { AuthType, MemberType } from '@hezo/shared';
import { Hono } from 'hono';
import { err, ok } from '../lib/response';
import { toSlug, uniqueSlug } from '../lib/slug';
import { terminalStatusParams } from '../lib/sql';
import type { Env } from '../lib/types';
import { requireSuperuser, requireTeamAccess } from '../middleware/auth';
import { getOnboardingStatus } from '../services/onboarding';
import { runOnboardingDirect } from '../services/onboarding-direct';
import {
	ensureOnboardingIntakeTask,
	getOpenOnboardingIntakeTask,
	postSkipQuestionsSignal,
} from '../services/onboarding-intake';
import { createTeam } from '../services/teams';

export const teamsRoutes = new Hono<Env>();

teamsRoutes.get('/teams', async (c) => {
	const db = c.get('db');
	const auth = c.get('auth');

	const isSuperuser = auth.type === AuthType.Board && auth.isSuperuser;
	const isBoard = auth.type === AuthType.Board;

	let query: string;
	const params: unknown[] = [MemberType.Agent];
	const ts = terminalStatusParams(2);
	params.push(...ts.values);
	const nextIdx = 2 + ts.values.length;

	if (!isBoard || isSuperuser) {
		query = `SELECT c.*,
       (SELECT count(*) FROM members m WHERE m.team_id = c.id AND m.member_type = $1)::int AS agent_count,
       (SELECT count(*) FROM tasks i WHERE i.team_id = c.id AND i.status NOT IN (${ts.placeholders}))::int AS open_task_count
     FROM teams c
     ORDER BY c.created_at DESC`;
	} else {
		query = `SELECT c.*,
       (SELECT count(*) FROM members m WHERE m.team_id = c.id AND m.member_type = $1)::int AS agent_count,
       (SELECT count(*) FROM tasks i WHERE i.team_id = c.id AND i.status NOT IN (${ts.placeholders}))::int AS open_task_count
     FROM teams c
     JOIN members m2 ON m2.team_id = c.id
     JOIN member_users mu ON mu.id = m2.id
     WHERE mu.user_id = $${nextIdx}
     ORDER BY c.created_at DESC`;
		params.push(auth.userId);
	}

	const result = await db.query(query, params);
	return ok(c, result.rows);
});

teamsRoutes.post('/teams', async (c) => {
	const denied = requireSuperuser(c);
	if (denied) return denied;

	const body = await c.req.json<{
		name: string;
		description?: string;
		template_id?: string;
	}>();

	if (!body.name?.trim()) {
		return err(c, 'INVALID_REQUEST', 'name is required', 400);
	}

	const auth = c.get('auth');
	const team = await createTeam(
		{
			db: c.get('db'),
			docker: c.get('docker'),
			dataDir: c.get('dataDir'),
			wsManager: c.get('wsManager'),
			masterKeyManager: c.get('masterKeyManager'),
			logs: c.get('logs'),
			egressCAPath: c.get('egressProxy')?.caCertPath ?? null,
		},
		{
			name: body.name.trim(),
			description: body.description,
			templateId: body.template_id,
			creatorUserId: auth.type === AuthType.Board ? auth.userId : undefined,
		},
	);

	return ok(c, team, 201);
});

teamsRoutes.get('/teams/:teamId/onboarding-intake', async (c) => {
	const access = await requireTeamAccess(c);
	if (access instanceof Response) return access;

	const ensure = c.req.query('ensure') === 'true';
	const intake = ensure
		? await ensureOnboardingIntakeTask(c.get('db'), access.teamId, c.get('wsManager'))
		: await getOpenOnboardingIntakeTask(c.get('db'), access.teamId);
	if (!intake) {
		return err(c, 'NOT_FOUND', 'Onboarding intake is not available for this team', 404);
	}
	return ok(c, intake);
});

teamsRoutes.post('/teams/:teamId/onboarding-intake/skip-questions', async (c) => {
	const access = await requireTeamAccess(c);
	if (access instanceof Response) return access;

	const intake = await getOpenOnboardingIntakeTask(c.get('db'), access.teamId);
	if (!intake) {
		return err(c, 'NOT_FOUND', 'No open onboarding intake to skip', 404);
	}

	const comment = await postSkipQuestionsSignal(c.get('db'), access.teamId, intake.task_id);
	if (!comment) {
		return err(c, 'INTERNAL', 'Failed to post skip signal', 500);
	}
	return ok(c, { task_id: intake.task_id, comment_id: comment.id });
});

teamsRoutes.get('/teams/:teamId/onboarding', async (c) => {
	const access = await requireTeamAccess(c);
	if (access instanceof Response) return access;

	const status = await getOnboardingStatus(c.get('db'), access.teamId);
	return ok(c, status);
});

teamsRoutes.post('/teams/:teamId/onboarding/direct', async (c) => {
	const access = await requireTeamAccess(c);
	if (access instanceof Response) return access;

	const body = await c.req.json<{
		template_id?: string;
		project_name?: string;
		project_description?: string;
		skip_planning_task?: boolean;
	}>();
	if (!body.template_id?.trim()) {
		return err(c, 'INVALID_REQUEST', 'template_id is required', 400);
	}
	if (!body.project_name?.trim()) {
		return err(c, 'INVALID_REQUEST', 'project_name is required', 400);
	}

	const result = await runOnboardingDirect(c.get('db'), {
		teamId: access.teamId,
		templateId: body.template_id.trim(),
		projectName: body.project_name.trim(),
		projectDescription: body.project_description,
		dataDir: c.get('dataDir'),
		wsManager: c.get('wsManager'),
		docker: c.get('docker'),
		masterKeyManager: c.get('masterKeyManager'),
		logs: c.get('logs'),
		sshAgentServer: c.get('sshAgentServer'),
		egressCAPath: c.get('egressProxy')?.caCertPath ?? null,
		skipPlanningTask: body.skip_planning_task === true,
	});

	if (!result.ok) {
		const status = result.code === 'NOT_FOUND' ? 404 : result.code === 'CONFLICT' ? 409 : 400;
		return err(c, result.code, result.message, status);
	}
	return ok(c, result, 201);
});

teamsRoutes.get('/teams/:teamId', async (c) => {
	const access = await requireTeamAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { teamId } = access;

	const ts2 = terminalStatusParams(3);
	const result = await db.query(
		`SELECT c.*,
       (SELECT count(*) FROM members m WHERE m.team_id = c.id AND m.member_type = $2)::int AS agent_count,
       (SELECT count(*) FROM tasks i WHERE i.team_id = c.id AND i.status NOT IN (${ts2.placeholders}))::int AS open_task_count
     FROM teams c WHERE c.id = $1`,
		[teamId, MemberType.Agent, ...ts2.values],
	);

	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Team not found', 404);
	}

	return ok(c, result.rows[0]);
});

teamsRoutes.patch('/teams/:teamId', async (c) => {
	const access = await requireTeamAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { teamId } = access;

	const existing = await db.query('SELECT id FROM teams WHERE id = $1', [teamId]);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Team not found', 404);
	}

	const body = await c.req.json<{
		name?: string;
		description?: string;
		mcp_servers?: unknown[];
		mpp_config?: Record<string, unknown>;
		settings?: Record<string, unknown>;
	}>();

	const sets: string[] = [];
	const params: unknown[] = [];
	let idx = 1;

	const addField = (field: string, value: unknown, jsonb = false) => {
		if (value !== undefined) {
			sets.push(`${field} = $${idx}${jsonb ? '::jsonb' : ''}`);
			params.push(jsonb ? JSON.stringify(value) : value);
			idx++;
		}
	};

	if (body.name?.trim()) {
		const newSlug = await uniqueSlug(toSlug(body.name), async (s) => {
			const r = await db.query('SELECT 1 FROM teams WHERE slug = $1 AND id != $2', [s, teamId]);
			return r.rows.length > 0;
		});
		addField('name', body.name.trim());
		addField('slug', newSlug);
	}
	addField('description', body.description);
	addField('mcp_servers', body.mcp_servers, true);
	addField('mpp_config', body.mpp_config, true);
	if (body.settings !== undefined) {
		sets.push(`settings = settings || $${idx}::jsonb`);
		params.push(JSON.stringify(body.settings));
		idx++;
	}

	if (sets.length === 0) {
		const result = await db.query('SELECT * FROM teams WHERE id = $1', [teamId]);
		return ok(c, result.rows[0]);
	}

	params.push(teamId);
	const result = await db.query(
		`UPDATE teams SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
		params,
	);

	return ok(c, result.rows[0]);
});

teamsRoutes.delete('/teams/:teamId', async (c) => {
	const access = await requireTeamAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { teamId } = access;

	const existing = await db.query('SELECT id FROM teams WHERE id = $1', [teamId]);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Team not found', 404);
	}

	await db.query('DELETE FROM teams WHERE id = $1', [teamId]);
	return c.json({ data: null }, 200);
});
