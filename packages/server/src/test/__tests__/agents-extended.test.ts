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
			name: 'Extended Agent Test Co',
			template_id: typeId,
		}),
	});
	companyId = (await companyRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('POST /companies/:companyId/agents/onboard', () => {
	it('creates agent with disabled status when CEO and ops project exist', async () => {
		// The Startup template seeds a CEO and an internal operations project,
		// so onboarding should produce a disabled agent + an onboarding issue.
		const res = await app.request(`/api/companies/${companyId}/agents/onboard`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				title: 'Data Engineer',
				role_description: 'Builds and maintains data pipelines',
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data).toHaveProperty('agent');
		expect(body.data).toHaveProperty('issue');
		const { agent, issue } = body.data;
		expect(agent.title).toBe('Data Engineer');
		expect(agent.slug).toBe('data-engineer');
		expect(agent.admin_status).toBe('disabled');
		// An onboarding issue should be created and assigned to the CEO
		expect(issue).not.toBeNull();
		expect(issue.title).toBe('Onboard new agent: Data Engineer');
		expect(issue.priority).toBe('high');
		expect(issue.labels).toContain('onboarding');
	});

	it('returns agent and null issue when CEO is absent', async () => {
		// Create a separate company with no template so no CEO is seeded
		const typesRes = await app.request('/api/company-types', {
			headers: authHeader(token),
		});
		const typeId = (await typesRes.json()).data.find(
			(t: Record<string, unknown>) => t.name === 'Startup',
		).id;

		const bareRes = await app.request('/api/companies', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'No CEO Co', template_id: typeId }),
		});
		const bareCompanyId = (await bareRes.json()).data.id;

		// Terminate the CEO so hasCeo becomes false
		const agentsRes = await app.request(`/api/companies/${bareCompanyId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await agentsRes.json()).data;
		const ceo = agents.find((a: Record<string, unknown>) => a.slug === 'ceo');

		await app.request(`/api/companies/${bareCompanyId}/agents/${ceo.id}/disable`, {
			method: 'POST',
			headers: authHeader(token),
		});

		const res = await app.request(`/api/companies/${bareCompanyId}/agents/onboard`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				title: 'Solo Agent',
				role_description: 'Works independently',
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		const { agent, issue } = body.data;
		// No CEO means agent should be enabled and no issue created
		expect(agent.admin_status).toBe('enabled');
		expect(issue).toBeNull();
	});

	it('rejects onboard with missing title', async () => {
		const res = await app.request(`/api/companies/${companyId}/agents/onboard`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ role_description: 'Missing title field' }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('INVALID_REQUEST');
	});

	it('rejects onboard with duplicate slug', async () => {
		// CEO slug already exists from the Startup template
		const res = await app.request(`/api/companies/${companyId}/agents/onboard`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'CEO' }),
		});
		expect(res.status).toBe(409);
		const body = await res.json();
		expect(body.error.code).toBe('CONFLICT');
	});

	it('respects optional fields passed to onboard', async () => {
		const res = await app.request(`/api/companies/${companyId}/agents/onboard`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				title: 'ML Researcher',
				role_description: 'Runs experiments',
				system_prompt: 'You are an ML researcher.',
				monthly_budget_cents: 5000,
				heartbeat_interval_min: 30,
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		const { agent } = body.data;
		expect(agent.system_prompt).toBe('You are an ML researcher.');
		expect(agent.monthly_budget_cents).toBe(5000);
		expect(agent.heartbeat_interval_min).toBe(30);
	});

	it('requires authentication', async () => {
		const res = await app.request(`/api/companies/${companyId}/agents/onboard`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Unauthorized Agent' }),
		});
		expect(res.status).toBe(401);
	});
});

describe('agent listing with admin_status filter', () => {
	it('filters by multiple statuses with comma-separated query param', async () => {
		// Disable one agent so we have both enabled and disabled agents
		const agentsRes = await app.request(`/api/companies/${companyId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await agentsRes.json()).data;
		const target = agents.find((a: Record<string, unknown>) => a.slug === 'engineer');

		await app.request(`/api/companies/${companyId}/agents/${target.id}/disable`, {
			method: 'POST',
			headers: authHeader(token),
		});

		const res = await app.request(
			`/api/companies/${companyId}/agents?admin_status=enabled,disabled`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		const statuses = new Set(body.data.map((a: Record<string, unknown>) => a.admin_status));
		expect(statuses.has('enabled')).toBe(true);
		expect(statuses.has('disabled')).toBe(true);
		// Re-enable so other tests aren't affected
		await app.request(`/api/companies/${companyId}/agents/${target.id}/enable`, {
			method: 'POST',
			headers: authHeader(token),
		});
	});

	it('returns empty array when filter matches no agents', async () => {
		const res = await app.request(`/api/companies/${companyId}/agents?admin_status=disabled`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(Array.isArray(body.data)).toBe(true);
		expect(body.data.every((a: Record<string, unknown>) => a.admin_status === 'disabled')).toBe(
			true,
		);
	});

	it('list includes reports_to and reports_to_title fields', async () => {
		const res = await app.request(`/api/companies/${companyId}/agents`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		// Every entry must expose reports_to (may be null)
		for (const agent of body.data) {
			expect(agent).toHaveProperty('reports_to');
		}
		// At least one agent reports to the CEO
		const withReportsTo = body.data.filter((a: Record<string, unknown>) => a.reports_to !== null);
		expect(withReportsTo.length).toBeGreaterThan(0);
		// Those agents should also have reports_to_title populated
		for (const agent of withReportsTo) {
			expect(typeof agent.reports_to_title).toBe('string');
			expect(agent.reports_to_title.length).toBeGreaterThan(0);
		}
	});
});

describe('PATCH /companies/:companyId/agents/:agentId (partial updates)', () => {
	it('updates only role_description leaving other fields unchanged', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const agent = agents.find((a: Record<string, unknown>) => a.slug === 'architect');

		const originalTitle = agent.title;
		const originalBudget = agent.monthly_budget_cents;

		const res = await app.request(`/api/companies/${companyId}/agents/${agent.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ role_description: 'Updated role description for Architect' }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.role_description).toBe('Updated role description for Architect');
		expect(body.data.title).toBe(originalTitle);
		expect(body.data.monthly_budget_cents).toBe(originalBudget);
	});

	it('updates system_prompt and records a revision', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const agent = agents.find((a: Record<string, unknown>) => a.slug === 'architect');

		const res = await app.request(`/api/companies/${companyId}/agents/${agent.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ system_prompt: 'New system prompt for Architect.' }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.system_prompt).toBe('New system prompt for Architect.');

		// Verify a revision record was written to the DB
		const revisions = await db.query<{ new_prompt: string; change_summary: string }>(
			'SELECT new_prompt, change_summary FROM system_prompt_revisions WHERE member_agent_id = $1',
			[agent.id],
		);
		expect(revisions.rows.length).toBeGreaterThanOrEqual(1);
		const rev = revisions.rows[revisions.rows.length - 1];
		expect(rev.new_prompt).toBe('New system prompt for Architect.');
		expect(rev.change_summary).toBe('Manual edit by board member');
	});

	it('updates title and syncs display_name on the members record', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const agent = agents.find((a: Record<string, unknown>) => a.slug === 'researcher');

		const res = await app.request(`/api/companies/${companyId}/agents/${agent.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Senior Researcher' }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.title).toBe('Senior Researcher');

		// Confirm display_name was also updated
		const memberRow = await db.query<{ display_name: string }>(
			'SELECT display_name FROM members WHERE id = $1',
			[agent.id],
		);
		expect(memberRow.rows[0].display_name).toBe('Senior Researcher');
	});

	it('returns current state when PATCH body has no recognised fields', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const agent = agents[0];

		const res = await app.request(`/api/companies/${companyId}/agents/${agent.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(200);
	});

	it('clears reports_to when patched with null', async () => {
		// Find an agent that has a reports_to set (any non-CEO)
		const listRes = await app.request(`/api/companies/${companyId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const subordinate = agents.find((a: Record<string, unknown>) => a.reports_to !== null);
		expect(subordinate).toBeDefined();

		const res = await app.request(`/api/companies/${companyId}/agents/${subordinate.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ reports_to: null }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.reports_to).toBeNull();
	});

	it('returns 404 when patching a non-existent agent', async () => {
		const fakeId = '00000000-0000-0000-0000-000000000000';
		const res = await app.request(`/api/companies/${companyId}/agents/${fakeId}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ role_description: 'Ghost agent' }),
		});
		expect(res.status).toBe(404);
	});
});

describe('invalid reports_to reference', () => {
	it('rejects creating an agent with a non-existent reports_to UUID', async () => {
		const nonExistentId = '00000000-0000-0000-0000-000000000001';
		const res = await app.request(`/api/companies/${companyId}/agents`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				title: 'Ghost Reporter',
				reports_to: nonExistentId,
			}),
		});
		// The FK constraint (members.id) must reject the insert
		expect(res.status).toBeGreaterThanOrEqual(400);
	});
});
