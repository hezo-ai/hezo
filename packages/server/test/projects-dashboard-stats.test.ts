import type { Hono } from 'hono';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let teamId: string;
let projectId: string;
let agentId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const teamRes = await createTestTeam(db, { name: 'Dashboard Co' });
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, { name: 'Main' });
	const projectData = (await projectRes.json()).data;
	projectId = projectData.id;

	const agentRes = await app.request(`/api/projects/${projectData.slug}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Runner' }),
	});
	agentId = (await agentRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

it('projects index carries running-agent count, today spend, and last activity', async () => {
	// One running agent on the team.
	await db.query(
		`UPDATE member_agents SET runtime_status = 'active'::agent_runtime_status WHERE id = $1`,
		[agentId],
	);
	// $2.50 spent today, plus $9.99 two days ago that must not count toward today.
	await db.query(
		`INSERT INTO cost_entries (member_id, project_id, amount_cents) VALUES ($1, $2, 250)`,
		[agentId, projectId],
	);
	await db.query(
		`INSERT INTO cost_entries (member_id, project_id, amount_cents, created_at)
		 VALUES ($1, $2, 999, now() - interval '2 days')`,
		[agentId, projectId],
	);

	const res = await app.request('/api/projects', { headers: authHeader(token) });
	expect(res.status).toBe(200);
	const projects = (await res.json()).data as Array<{
		id: string;
		running_agents_count: number;
		today_spend_cents: number;
		last_activity_at: string | null;
	}>;
	const p = projects.find((x) => x.id === projectId);
	if (!p) throw new Error('project missing from index');
	expect(p.running_agents_count).toBe(1);
	expect(p.today_spend_cents).toBe(250);
	expect(p.last_activity_at).toBeTruthy();
});

it('a project with no active agents and no spend reports zeros', async () => {
	await db.query(
		`UPDATE member_agents SET runtime_status = 'idle'::agent_runtime_status WHERE id = $1`,
		[agentId],
	);
	const teamRes = await createTestTeam(db, { name: 'Quiet Co' });
	const quietTeamId = (await teamRes.json()).data.id;
	const quietRes = await createTestProject(db, quietTeamId, { name: 'Quiet' });
	const quietId = (await quietRes.json()).data.id;

	const res = await app.request('/api/projects', { headers: authHeader(token) });
	const projects = (await res.json()).data as Array<{
		id: string;
		running_agents_count: number;
		today_spend_cents: number;
	}>;
	const quiet = projects.find((x) => x.id === quietId);
	if (!quiet) throw new Error('quiet project missing');
	expect(quiet.running_agents_count).toBe(0);
	expect(quiet.today_spend_cents).toBe(0);
});
