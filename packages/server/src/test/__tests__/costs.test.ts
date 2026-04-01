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
let agentId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/company-types', {
		headers: authHeader(token),
	});
	const typeId = (await typesRes.json()).data.find((t: any) => t.is_builtin).id;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'Cost Co',
			company_type_id: typeId,
			issue_prefix: 'COST',
		}),
	});
	companyId = (await companyRes.json()).data.id;

	const agentsRes = await app.request(`/api/companies/${companyId}/agents`, {
		headers: authHeader(token),
	});
	// Use the engineer (has 5000 budget)
	agentId = (await agentsRes.json()).data.find(
		(a: Record<string, unknown>) => a.slug === 'engineer',
	).id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('costs CRUD', () => {
	it('creates a cost entry with budget debit', async () => {
		const res = await app.request(`/api/companies/${companyId}/costs`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				member_id: agentId,
				amount_cents: 100,
				description: 'Tool call cost',
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.amount_cents).toBe(100);
	});

	it('lists cost entries', async () => {
		const res = await app.request(`/api/companies/${companyId}/costs`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.entries.length).toBeGreaterThanOrEqual(1);
		expect(body.data.total_cents).toBeGreaterThan(0);
	});

	it('groups costs by agent', async () => {
		const res = await app.request(`/api/companies/${companyId}/costs?group_by=agent`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.summary.length).toBeGreaterThanOrEqual(1);
		expect(body.data.total_cents).toBeGreaterThan(0);
	});

	it('rejects budget-exceeding cost', async () => {
		// Engineer budget is 5000 cents
		const res = await app.request(`/api/companies/${companyId}/costs`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				member_id: agentId,
				amount_cents: 99999,
				description: 'Way too expensive',
			}),
		});
		expect(res.status).toBe(402);
		const body = await res.json();
		expect(body.error.code).toBe('BUDGET_EXCEEDED');
	});
});
