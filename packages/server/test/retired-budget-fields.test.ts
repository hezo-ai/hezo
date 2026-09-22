import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

// Budgets count tokens. A request still sending a dollar budget field is
// refused with the field that replaced it, never saved or ignored in silence.

let app: Hono<Env>;
let db: Db;
let token: string;
let projectSlug: string;
let agentId: string;
let agentTypeId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	// biome-ignore lint/suspicious/noExplicitAny: test JSON
	const templateId = (await typesRes.json()).data.find((t: any) => t.name === 'App Team').id;
	const teamRes = await createTestTeam(db, { name: 'Retired Fields Co', template_id: templateId });
	const teamId = (await teamRes.json()).data.id;
	const project = (await (await createTestProject(db, teamId, { name: 'Retired' })).json()).data;
	projectSlug = project.slug;
	const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		headers: authHeader(token),
	});
	agentId = (await agentsRes.json()).data[0].id;
	const typeRes = await app.request('/api/agent-types', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Retired fields analyst', monthly_budget_tokens: 5_000_000 }),
	});
	agentTypeId = (await typeRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

async function send(method: 'POST' | 'PATCH', path: string, body: Record<string, unknown>) {
	const res = await app.request(path, {
		method,
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	return { status: res.status, body: await res.json() };
}

describe('a retired dollar budget field', () => {
	it('is refused on a project update, and the budget is left alone', async () => {
		const res = await send('PATCH', `/api/projects/${projectSlug}`, { monthly_budget_cents: 3000 });
		expect(res.status).toBe(400);
		expect(res.body.error.message).toContain('monthly_budget_cents -> monthly_budget_tokens');
		const row = await db.query<{ monthly_budget_tokens: number }>(
			'SELECT monthly_budget_tokens FROM projects WHERE slug = $1',
			[projectSlug],
		);
		expect(row.rows[0].monthly_budget_tokens).toBe(0);
	});

	it('is refused on an agent update, naming every retired field sent', async () => {
		const res = await send('PATCH', `/api/projects/${projectSlug}/agents/${agentId}`, {
			daily_budget_cents: 100,
			weekly_budget_cents: 700,
		});
		expect(res.status).toBe(400);
		expect(res.body.error.message).toContain('daily_budget_cents -> daily_budget_tokens');
		expect(res.body.error.message).toContain('weekly_budget_cents -> weekly_budget_tokens');
	});

	it('is refused when hiring an agent', async () => {
		const res = await send('POST', `/api/projects/${projectSlug}/agents`, {
			title: 'Priced hire',
			monthly_budget_cents: 3000,
		});
		expect(res.status).toBe(400);
		expect(res.body.error.message).toContain('monthly_budget_tokens');
		const hired = await db.query("SELECT 1 FROM member_agents WHERE title = 'Priced hire'");
		expect(hired.rows).toEqual([]);
	});

	it('is refused on an agent type, created or updated', async () => {
		const created = await send('POST', '/api/agent-types', {
			name: 'Priced type',
			monthly_budget_cents: 3000,
		});
		expect(created.status).toBe(400);
		const updated = await send('PATCH', `/api/agent-types/${agentTypeId}`, {
			monthly_budget_cents: 3000,
		});
		expect(updated.status).toBe(400);
		expect(updated.body.error.message).toContain('monthly_budget_tokens');
	});

	it('leaves the token field working', async () => {
		const res = await send('PATCH', `/api/agent-types/${agentTypeId}`, {
			monthly_budget_tokens: 9_000_000,
		});
		expect(res.status).toBe(200);
		expect(res.body.data.monthly_budget_tokens).toBe(9_000_000);
	});
});
