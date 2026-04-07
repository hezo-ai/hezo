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
let agent2Id: string;
let projectId: string;
let project2Id: string;
let issueId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	// Create company with Startup template
	const typesRes = await app.request('/api/company-types', {
		headers: authHeader(token),
	});
	const typeId = (await typesRes.json()).data.find((t: any) => t.name === 'Startup').id;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'Extended Cost Co',
			template_id: typeId,
			issue_prefix: 'EXT',
		}),
	});
	companyId = (await companyRes.json()).data.id;

	// Get two agents to work with
	const agentsRes = await app.request(`/api/companies/${companyId}/agents`, {
		headers: authHeader(token),
	});
	const agents = (await agentsRes.json()).data;
	agentId = agents.find((a: Record<string, unknown>) => a.slug === 'engineer').id;
	agent2Id = agents.find((a: Record<string, unknown>) => a.slug === 'ui-designer').id;

	// Create two projects
	const proj1Res = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Project Alpha' }),
	});
	projectId = (await proj1Res.json()).data.id;

	const proj2Res = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Project Beta' }),
	});
	project2Id = (await proj2Res.json()).data.id;

	// Create an issue under project 1
	const issueRes = await app.request(`/api/companies/${companyId}/issues`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			title: 'Test Issue',
			project_id: projectId,
			assignee_id: agentId,
		}),
	});
	issueId = (await issueRes.json()).data.id;

	// Insert cost entries with varied dates, agents, and projects directly via DB
	// so we can control timestamps precisely for date-range tests.
	// All amounts are small to stay within budget limits.
	await db.query(
		`INSERT INTO cost_entries (company_id, member_id, project_id, issue_id, amount_cents, description, created_at)
     VALUES
       ($1, $2, $3, $4, 50,  'past entry',          '2024-01-15 10:00:00+00'),
       ($1, $2, $3, NULL, 75,  'past no-issue',      '2024-01-20 12:00:00+00'),
       ($1, $5, $6, NULL, 120, 'agent2 project2',    '2024-02-10 08:00:00+00'),
       ($1, $2, NULL, NULL, 30, 'agent1 no project',  '2024-03-01 09:00:00+00')`,
		[companyId, agentId, projectId, issueId, agent2Id, project2Id],
	);
});

afterAll(async () => {
	await safeClose(db);
});

describe('costs – date range filtering', () => {
	it('filters by from date (inclusive)', async () => {
		const res = await app.request(`/api/companies/${companyId}/costs?from=2024-02-01`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		// Only entries on/after 2024-02-01: agent2 (120) + agent1 no-project (30)
		expect(body.data.entries.length).toBe(2);
		expect(body.data.total_cents).toBe(150);
	});

	it('filters by to date (inclusive)', async () => {
		const res = await app.request(`/api/companies/${companyId}/costs?to=2024-01-31`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		// Only entries on/before 2024-01-31: past entry (50) + past no-issue (75)
		expect(body.data.entries.length).toBe(2);
		expect(body.data.total_cents).toBe(125);
	});

	it('filters by from and to range together', async () => {
		const res = await app.request(
			`/api/companies/${companyId}/costs?from=2024-01-18&to=2024-02-28`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		// Entries in range: past no-issue (75, Jan 20) + agent2 project2 (120, Feb 10)
		expect(body.data.entries.length).toBe(2);
		expect(body.data.total_cents).toBe(195);
	});
});

describe('costs – project_id filter', () => {
	it('returns only entries for the specified project', async () => {
		const res = await app.request(`/api/companies/${companyId}/costs?project_id=${projectId}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		// past entry (50) + past no-issue (75) both belong to project 1
		expect(body.data.entries.length).toBe(2);
		for (const entry of body.data.entries) {
			expect(entry.project_id).toBe(projectId);
		}
	});

	it('returns only entries for project2', async () => {
		const res = await app.request(`/api/companies/${companyId}/costs?project_id=${project2Id}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.entries.length).toBe(1);
		expect(body.data.total_cents).toBe(120);
	});
});

describe('costs – issue_id filter', () => {
	it('returns only entries linked to the specified issue', async () => {
		const res = await app.request(`/api/companies/${companyId}/costs?issue_id=${issueId}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		// Only "past entry" (50) has issue_id set
		expect(body.data.entries.length).toBe(1);
		expect(body.data.entries[0].issue_id).toBe(issueId);
		expect(body.data.total_cents).toBe(50);
	});
});

describe('costs – group_by=day', () => {
	it('groups cost entries by day with correct totals', async () => {
		const res = await app.request(`/api/companies/${companyId}/costs?group_by=day`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.summary).toBeDefined();
		// We have 4 entries across 4 distinct days
		expect(body.data.summary.length).toBe(4);
		// Days are ordered ascending
		const days = body.data.summary.map((r: any) => r.day);
		expect(days).toEqual([...days].sort());
		// Total across all days
		expect(body.data.total_cents).toBe(275); // 50+75+120+30
	});

	it('group_by=day with date range returns subset', async () => {
		const res = await app.request(
			`/api/companies/${companyId}/costs?group_by=day&from=2024-02-01&to=2024-03-31`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.summary.length).toBe(2);
		expect(body.data.total_cents).toBe(150); // 120+30
	});
});

describe('costs – group_by=project', () => {
	it('groups cost entries by project', async () => {
		const res = await app.request(`/api/companies/${companyId}/costs?group_by=project`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.summary).toBeDefined();

		const proj1Row = body.data.summary.find((r: any) => r.project_id === projectId);
		const proj2Row = body.data.summary.find((r: any) => r.project_id === project2Id);
		const nullRow = body.data.summary.find((r: any) => r.project_id === null);

		expect(proj1Row).toBeDefined();
		expect(proj1Row.total_cents).toBe(125); // 50+75
		expect(proj2Row).toBeDefined();
		expect(proj2Row.total_cents).toBe(120);
		// The entry with no project lands in the null bucket
		expect(nullRow).toBeDefined();
		expect(nullRow.total_cents).toBe(30);

		expect(body.data.total_cents).toBe(275);
	});
});

describe('costs – POST validation', () => {
	it('returns 400 when member_id is missing', async () => {
		const res = await app.request(`/api/companies/${companyId}/costs`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ amount_cents: 100 }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('INVALID_REQUEST');
	});

	it('returns 400 when amount_cents is zero', async () => {
		const res = await app.request(`/api/companies/${companyId}/costs`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ member_id: agentId, amount_cents: 0 }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('INVALID_REQUEST');
	});

	it('returns 400 when amount_cents is negative', async () => {
		const res = await app.request(`/api/companies/${companyId}/costs`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ member_id: agentId, amount_cents: -50 }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('INVALID_REQUEST');
	});

	it('returns 400 when amount_cents is missing', async () => {
		const res = await app.request(`/api/companies/${companyId}/costs`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ member_id: agentId }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('INVALID_REQUEST');
	});
});
