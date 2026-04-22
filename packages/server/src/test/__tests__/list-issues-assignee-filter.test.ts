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
let projectId: string;
let ceoId: string;
let architectId: string;
let architectSlug: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/company-types', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'Startup',
	).id;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'List Issues Filter Co',
			template_id: typeId,
		}),
	});
	companyId = (await companyRes.json()).data.id;

	const agentsRes = await app.request(`/api/companies/${companyId}/agents`, {
		headers: authHeader(token),
	});
	const agents = (await agentsRes.json()).data as Array<{ id: string; slug: string }>;
	const ceo = agents.find((a) => a.slug === 'ceo');
	const architect = agents.find((a) => a.slug === 'architect');
	if (!ceo || !architect) throw new Error('Expected CEO and architect agents in seed');
	ceoId = ceo.id;
	architectId = architect.id;
	architectSlug = architect.slug;

	const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Filter Test Project', description: 'Test project.' }),
	});
	projectId = (await projectRes.json()).data.id;

	// Create three issues: two assigned to architect, one to CEO. Mark one of
	// architect's issues as 'done' so we can verify the status filter.
	const arch1 = await app.request(`/api/companies/${companyId}/issues`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectId,
			title: 'Architect open issue',
			assignee_id: architectId,
		}),
	});
	const arch1Id = (await arch1.json()).data.id;
	void arch1Id;

	const arch2 = await app.request(`/api/companies/${companyId}/issues`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectId,
			title: 'Architect done issue',
			assignee_id: architectId,
		}),
	});
	const arch2Id = (await arch2.json()).data.id;

	await app.request(`/api/companies/${companyId}/issues/${arch2Id}`, {
		method: 'PATCH',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ status: 'done' }),
	});

	await app.request(`/api/companies/${companyId}/issues`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectId,
			title: 'CEO issue',
			assignee_id: ceoId,
		}),
	});
});

afterAll(async () => {
	await safeClose(db);
});

async function callListIssues(
	args: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'tools/call',
			params: { name: 'list_issues', arguments: { company_id: companyId, ...args } },
			id: 1,
		}),
	});
	const body = (await res.json()) as {
		result: { content: Array<{ type: string; text: string }> };
	};
	return JSON.parse(body.result.content[0].text) as Array<Record<string, unknown>>;
}

describe('list_issues MCP tool: assignee filters', () => {
	it("filters by assignee_slug to return only that agent's issues", async () => {
		const rows = await callListIssues({ assignee_slug: architectSlug });
		expect(rows.length).toBeGreaterThanOrEqual(2);
		for (const row of rows) {
			expect(row.assignee_id).toBe(architectId);
		}
	});

	it('combines assignee_slug with status filter (AND)', async () => {
		const rows = await callListIssues({ assignee_slug: architectSlug, status: 'backlog' });
		for (const row of rows) {
			expect(row.assignee_id).toBe(architectId);
			expect(row.status).toBe('backlog');
		}
		// Architect has one backlog issue (the open one); the done one is filtered out.
		expect(rows.length).toBe(1);
	});

	it('accepts assignee_id directly and ignores assignee_slug when both are given', async () => {
		const rows = await callListIssues({
			assignee_id: architectId,
			assignee_slug: 'definitely-not-real',
		});
		expect(rows.length).toBeGreaterThanOrEqual(2);
		for (const row of rows) {
			expect(row.assignee_id).toBe(architectId);
		}
	});

	it('returns an empty array (not an error) for an unknown assignee_slug', async () => {
		const rows = await callListIssues({ assignee_slug: 'nonexistent-agent-slug' });
		expect(Array.isArray(rows)).toBe(true);
		expect(rows.length).toBe(0);
	});
});
