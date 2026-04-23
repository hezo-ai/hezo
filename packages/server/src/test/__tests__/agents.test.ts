import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let companyId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/company-types', {
		headers: authHeader(token),
	});
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'Startup',
	).id;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'Agent Test Co',
			template_id: typeId,
		}),
	});
	companyId = (await companyRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('agents CRUD', () => {
	it('lists all 9 auto-created agents', async () => {
		const res = await app.request(`/api/companies/${companyId}/agents`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toHaveLength(11);
	});

	it('all agents start with idle runtime_status and enabled admin_status', async () => {
		const res = await app.request(`/api/companies/${companyId}/agents`, {
			headers: authHeader(token),
		});
		const body = await res.json();
		for (const agent of body.data) {
			expect(agent.runtime_status).toBe('idle');
			expect(agent.admin_status).toBe('enabled');
		}
	});

	it('filters agents by admin_status', async () => {
		const res = await app.request(`/api/companies/${companyId}/agents?admin_status=enabled`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(1);
		expect(body.data.every((a: Record<string, unknown>) => a.admin_status === 'enabled')).toBe(
			true,
		);
	});

	it('gets an agent by id with full detail', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const ceo = agents.find((a: Record<string, unknown>) => a.slug === 'ceo');

		const res = await app.request(`/api/companies/${companyId}/agents/${ceo.id}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.title).toBe('CEO');
		expect(body.data).toHaveProperty('system_prompt');
		expect(body.data).toHaveProperty('mcp_servers');
		expect(body.data).toHaveProperty('runtime_status');
		expect(body.data).toHaveProperty('admin_status');
	});

	it('seeds the architect with a PRD gate instruction', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const architect = agents.find((a: Record<string, unknown>) => a.slug === 'architect');

		const res = await app.request(`/api/companies/${companyId}/agents/${architect.id}`, {
			headers: authHeader(token),
		});
		const body = await res.json();
		const prompt = body.data.system_prompt as string;

		expect(prompt).toMatch(/read_project_doc/);
		expect(prompt).toMatch(/prd\.md/);
		expect(prompt).toMatch(/@-?mention the Product Lead/i);
		expect(prompt).toMatch(/PRD gate/i);
	});

	it('no agent system prompt references a .dev/ path for project docs', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const anyDevFolderRef = /\.dev\//;
		for (const summary of agents) {
			const res = await app.request(`/api/companies/${companyId}/agents/${summary.id}`, {
				headers: authHeader(token),
			});
			const body = await res.json();
			const prompt = body.data.system_prompt as string;
			expect(prompt).not.toMatch(anyDevFolderRef);
		}
	});

	it('creates (hires) a custom agent', async () => {
		const res = await app.request(`/api/companies/${companyId}/agents`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				title: 'Data Scientist',
				role_description: 'Analyzes data and builds ML models',
				monthly_budget_cents: 4000,
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.title).toBe('Data Scientist');
		expect(body.data.slug).toBe('data-scientist');
		expect(body.data.runtime_status).toBe('idle');
		expect(body.data.admin_status).toBe('enabled');
	});

	it('updates an agent', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const engineer = agents.find((a: Record<string, unknown>) => a.slug === 'engineer');

		const res = await app.request(`/api/companies/${companyId}/agents/${engineer.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ monthly_budget_cents: 8000 }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.monthly_budget_cents).toBe(8000);
	});

	it('disables an enabled agent', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const researcher = agents.find((a: Record<string, unknown>) => a.slug === 'researcher');

		const res = await app.request(`/api/companies/${companyId}/agents/${researcher.id}/disable`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.admin_status).toBe('disabled');
	});

	it('rejects disabling an already disabled agent', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const researcher = agents.find((a: Record<string, unknown>) => a.slug === 'researcher');

		const res = await app.request(`/api/companies/${companyId}/agents/${researcher.id}/disable`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(409);
	});

	it('enables a disabled agent', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const researcher = agents.find((a: Record<string, unknown>) => a.slug === 'researcher');

		const res = await app.request(`/api/companies/${companyId}/agents/${researcher.id}/enable`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.admin_status).toBe('enabled');
	});

	it('rejects enabling an already enabled agent', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const researcher = agents.find((a: Record<string, unknown>) => a.slug === 'researcher');

		const res = await app.request(`/api/companies/${companyId}/agents/${researcher.id}/enable`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(409);
	});

	it('disabling an agent unassigns its open issues', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const marketingLead = agents.find((a: Record<string, unknown>) => a.slug === 'marketing-lead');

		const res = await app.request(
			`/api/companies/${companyId}/agents/${marketingLead.id}/disable`,
			{ method: 'POST', headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.admin_status).toBe('disabled');
	});

	it('returns org chart with runtime_status and admin_status', async () => {
		const res = await app.request(`/api/companies/${companyId}/org-chart`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.board).toBeDefined();
		expect(body.data.board.children.length).toBeGreaterThan(0);
		const ceo = body.data.board.children.find((c: Record<string, unknown>) => c.title === 'CEO');
		expect(ceo).toBeDefined();
		expect(ceo).toHaveProperty('runtime_status');
		expect(ceo).toHaveProperty('admin_status');
		expect(ceo.children.length).toBeGreaterThan(0);
	});

	it('rejects duplicate agent slug', async () => {
		const res = await app.request(`/api/companies/${companyId}/agents`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'CEO' }),
		});
		expect(res.status).toBe(409);
	});
});

describe('heartbeat runs', () => {
	it('returns empty array when no runs exist', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const agent = agents[0];

		const res = await app.request(`/api/companies/${companyId}/agents/${agent.id}/heartbeat-runs`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toEqual([]);
	});

	it('returns runs after inserting heartbeat records', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const agent = agents[0];

		await db.query(
			`INSERT INTO heartbeat_runs (member_id, company_id, status, started_at, finished_at, exit_code, log_text)
			 VALUES ($1, $2, 'succeeded', now() - interval '5 minutes', now(), 0, 'All done')`,
			[agent.id, companyId],
		);

		const res = await app.request(`/api/companies/${companyId}/agents/${agent.id}/heartbeat-runs`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(1);
		expect(body.data[0].status).toBe('succeeded');
		expect(body.data[0].exit_code).toBe(0);
		expect(body.data[0].log_text).toBe('All done');
	});
});
