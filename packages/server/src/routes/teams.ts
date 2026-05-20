import { AuthType, MemberType } from '@hezo/shared';
import { Hono } from 'hono';
import { err, ok } from '../lib/response';
import { toSlug, uniqueSlug } from '../lib/slug';
import { terminalStatusParams } from '../lib/sql';
import type { Env } from '../lib/types';
import { requireSuperuser, requireTeamAccess } from '../middleware/auth';
import { getOpenHireTeamIntakeIssue } from '../services/hire-team-intake';
import { confirmProjectExecutionStart, getOnboardingStatus } from '../services/onboarding';
import {
	ensureRequirementsIntakeIssue,
	getOpenRequirementsIntakeIssue,
} from '../services/requirements-intake';
import { createTeam } from '../services/team-create';

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
       (SELECT count(*) FROM issues i WHERE i.team_id = c.id AND i.status NOT IN (${ts.placeholders}))::int AS open_issue_count
     FROM teams c
     ORDER BY c.created_at DESC`;
	} else {
		query = `SELECT c.*,
       (SELECT count(*) FROM members m WHERE m.team_id = c.id AND m.member_type = $1)::int AS agent_count,
       (SELECT count(*) FROM issues i WHERE i.team_id = c.id AND i.status NOT IN (${ts.placeholders}))::int AS open_issue_count
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

teamsRoutes.get('/teams/:teamId/requirements-intake', async (c) => {
	const access = await requireTeamAccess(c);
	if (access instanceof Response) return access;

	const ensure = c.req.query('ensure') === 'true';
	const intake = ensure
		? await ensureRequirementsIntakeIssue(c.get('db'), access.teamId, c.get('wsManager'))
		: await getOpenRequirementsIntakeIssue(c.get('db'), access.teamId);
	if (!intake) {
		return err(c, 'NOT_FOUND', 'Requirements intake is not available for this team', 404);
	}
	return ok(c, intake);
});

teamsRoutes.get('/teams/:teamId/onboarding', async (c) => {
	const access = await requireTeamAccess(c);
	if (access instanceof Response) return access;

	const status = await getOnboardingStatus(c.get('db'), access.teamId);
	return ok(c, status);
});

teamsRoutes.post('/teams/:teamId/onboarding/start-project', async (c) => {
	const access = await requireTeamAccess(c);
	if (access instanceof Response) return access;

	const result = await confirmProjectExecutionStart(c.get('db'), access.teamId);
	if ('error' in result) {
		return err(c, 'INVALID_REQUEST', result.error, 400);
	}
	return ok(c, result);
});

teamsRoutes.get('/teams/:teamId/hire-team-intake', async (c) => {
	const access = await requireTeamAccess(c);
	if (access instanceof Response) return access;

	const intake = await getOpenHireTeamIntakeIssue(c.get('db'), access.teamId);
	if (!intake) {
		return err(c, 'NOT_FOUND', 'Hire-the-team intake is not available for this team', 404);
	}
	return ok(c, intake);
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
       (SELECT count(*) FROM issues i WHERE i.team_id = c.id AND i.status NOT IN (${ts2.placeholders}))::int AS open_issue_count
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
