import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let teamId: string;
let projectId: string;
let projectSlug: string;
let agentId: string;
let agentSlug: string;

const jsonHeaders = () => ({ ...authHeader(token), 'Content-Type': 'application/json' });

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const templates = (await typesRes.json()) as { data: Array<{ id: string; name: string }> };
	const typeId = templates.data.find((t) => t.name === 'Startup')?.id;

	const teamRes = await createTestTeam(db, { name: 'Budget Rules Co', template_id: typeId });
	const teamSlug = (await teamRes.json()).data.slug;
	teamId = (await db.query<{ id: string }>('SELECT id FROM teams WHERE slug = $1', [teamSlug]))
		.rows[0].id;

	const projectRes = await createTestProject(db, teamId, { name: 'Rules Project' });
	const project = (await projectRes.json()).data;
	projectId = project.id;
	projectSlug = project.slug;

	const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		headers: authHeader(token),
	});
	const agents = (await agentsRes.json()) as { data: Array<{ id: string; slug: string }> };
	const engineer = agents.data.find((a) => a.slug === 'engineer');
	if (!engineer) throw new Error('engineer agent not seeded');
	agentId = engineer.id;
	agentSlug = engineer.slug;
});

afterAll(async () => {
	await safeClose(db);
});

beforeEach(async () => {
	await db.query(
		'UPDATE member_agents SET daily_budget_cents = 0, weekly_budget_cents = 0, monthly_budget_cents = 0 WHERE id = $1',
		[agentId],
	);
	await db.query(
		'UPDATE projects SET daily_budget_cents = 0, weekly_budget_cents = 0, monthly_budget_cents = 0 WHERE id = $1',
		[projectId],
	);
});

function patchProject(body: Record<string, number>) {
	return app.request(`/api/projects/${projectSlug}`, {
		method: 'PATCH',
		headers: jsonHeaders(),
		body: JSON.stringify(body),
	});
}

function patchAgent(body: Record<string, number>) {
	return app.request(`/api/projects/${projectSlug}/agents/${agentSlug}`, {
		method: 'PATCH',
		headers: jsonHeaders(),
		body: JSON.stringify(body),
	});
}

describe('project budget PATCH cross-window validation', () => {
	it('rejects a weekly budget below daily × 7', async () => {
		const res = await patchProject({
			daily_budget_cents: 2000,
			weekly_budget_cents: 5000, // < 14000
			monthly_budget_cents: 0,
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/weekly budget must be at least/i);
	});

	it('accepts the trio when the offending window is disabled (0)', async () => {
		const res = await patchProject({
			daily_budget_cents: 2000,
			weekly_budget_cents: 0, // unlimited → no constraint
			monthly_budget_cents: 70000,
		});
		expect(res.status).toBe(200);
	});

	it('validates against the stored value when a single window is patched', async () => {
		// Store a daily budget first.
		expect((await patchProject({ daily_budget_cents: 2000 })).status).toBe(200);
		// Now patch only weekly to an incoherent value — must merge with stored daily.
		const bad = await patchProject({ weekly_budget_cents: 5000 });
		expect(bad.status).toBe(400);
		// A coherent weekly against the stored daily passes.
		const good = await patchProject({ weekly_budget_cents: 20000 });
		expect(good.status).toBe(200);
	});
});

describe('agent budget PATCH cross-window validation', () => {
	it('rejects an incoherent monthly budget', async () => {
		const res = await patchAgent({
			daily_budget_cents: 2000,
			weekly_budget_cents: 0,
			monthly_budget_cents: 5000, // < ceil(2000*365/12)=60834
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/monthly budget must be at least/i);
	});

	it('persists a coherent trio', async () => {
		const res = await patchAgent({
			daily_budget_cents: 2000,
			weekly_budget_cents: 20000,
			monthly_budget_cents: 90000,
		});
		expect(res.status).toBe(200);
		const row = await db.query<{ daily_budget_cents: number; weekly_budget_cents: number }>(
			'SELECT daily_budget_cents, weekly_budget_cents FROM member_agents WHERE id = $1',
			[agentId],
		);
		expect(row.rows[0]).toEqual({ daily_budget_cents: 2000, weekly_budget_cents: 20000 });
	});
});

describe('agent create persists + validates all three windows', () => {
	it('rejects an incoherent trio at create time', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/agents`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({
				title: 'Bad Budget Hire',
				daily_budget_cents: 2000,
				weekly_budget_cents: 5000,
			}),
		});
		expect(res.status).toBe(400);
	});

	it('stores the daily/weekly windows passed at create time', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/agents`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({
				title: 'Good Budget Hire',
				daily_budget_cents: 1000,
				weekly_budget_cents: 20000,
				monthly_budget_cents: 90000,
			}),
		});
		expect(res.status).toBe(201);
		const created = (await res.json()).data;
		expect(created.daily_budget_cents).toBe(1000);
		expect(created.weekly_budget_cents).toBe(20000);
		expect(created.monthly_budget_cents).toBe(90000);
	});
});

describe('agent onboard threads all three windows', () => {
	it('rejects an incoherent trio before proposing the hire', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/agents/onboard`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({
				title: 'Onboard Bad',
				daily_budget_cents: 2000,
				weekly_budget_cents: 5000,
			}),
		});
		expect(res.status).toBe(400);
	});

	it('carries daily/weekly through the hire (approval payload or bootstrap insert)', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/agents/onboard`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({
				title: 'Onboard Good',
				daily_budget_cents: 1000,
				weekly_budget_cents: 20000,
				monthly_budget_cents: 90000,
			}),
		});
		expect(res.status).toBe(201);
		const result = (await res.json()).data;
		if (result.bootstrap) {
			// No coordination: the agent was created directly.
			expect(result.agent.daily_budget_cents).toBe(1000);
			expect(result.agent.weekly_budget_cents).toBe(20000);
		} else {
			// Coordinated: the windows ride in the pending hire approval payload, to be
			// materialised by approval-handlers/hire.ts on approval.
			const payload = await db.query<{ payload: Record<string, number> }>(
				`SELECT payload FROM approvals WHERE team_id = $1 AND payload->>'slug' = 'onboard-good'`,
				[teamId],
			);
			expect(payload.rows[0].payload.daily_budget_cents).toBe(1000);
			expect(payload.rows[0].payload.weekly_budget_cents).toBe(20000);
		}
	});
});
