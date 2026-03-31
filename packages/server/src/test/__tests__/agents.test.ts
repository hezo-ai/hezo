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

	// Create a company with agents
	const typesRes = await app.request('/api/company-types', {
		headers: authHeader(token),
	});
	const typeId = (await typesRes.json()).data.find((t: any) => t.is_builtin).id;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'Agent Test Co',
			company_type_id: typeId,
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
		expect(body.data).toHaveLength(9);
	});

	it('filters agents by status', async () => {
		const res = await app.request(`/api/companies/${companyId}/agents?status=idle`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		// DevOps Engineer starts idle
		expect(body.data.length).toBeGreaterThanOrEqual(1);
		expect(body.data.every((a: any) => a.status === 'idle')).toBe(true);
	});

	it('gets an agent by id with full detail', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const ceo = agents.find((a: any) => a.slug === 'ceo');

		const res = await app.request(`/api/companies/${companyId}/agents/${ceo.id}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.title).toBe('CEO');
		expect(body.data).toHaveProperty('system_prompt');
		expect(body.data).toHaveProperty('mcp_servers');
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
	});

	it('updates an agent', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const engineer = agents.find((a: any) => a.slug === 'engineer');

		const res = await app.request(`/api/companies/${companyId}/agents/${engineer.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ monthly_budget_cents: 8000 }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.monthly_budget_cents).toBe(8000);
	});

	it('pauses an active agent', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const researcher = agents.find((a: any) => a.slug === 'researcher');

		const res = await app.request(`/api/companies/${companyId}/agents/${researcher.id}/pause`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.status).toBe('paused');
	});

	it('resumes a paused agent', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const researcher = agents.find((a: any) => a.slug === 'researcher');

		const res = await app.request(`/api/companies/${companyId}/agents/${researcher.id}/resume`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.status).toBe('idle');
	});

	it('terminates an agent', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const marketingLead = agents.find((a: any) => a.slug === 'marketing-lead');

		const res = await app.request(
			`/api/companies/${companyId}/agents/${marketingLead.id}/terminate`,
			{ method: 'POST', headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.status).toBe('terminated');
	});

	it('returns org chart', async () => {
		const res = await app.request(`/api/companies/${companyId}/org-chart`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.board).toBeDefined();
		expect(body.data.board.children.length).toBeGreaterThan(0);
		// CEO should be at top level with children
		const ceo = body.data.board.children.find((c: any) => c.title === 'CEO');
		expect(ceo).toBeDefined();
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
