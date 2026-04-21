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
	it('creates a hire approval and CEO ticket, but no agent yet', async () => {
		const res = await app.request(`/api/companies/${companyId}/agents/onboard`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				title: 'Data Engineer',
				role_description: 'Builds and maintains data pipelines',
				system_prompt: 'Draft prompt',
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		const { agent, issue, approval, bootstrap } = body.data;

		expect(bootstrap).toBe(false);
		expect(agent).toBeNull();
		expect(issue).not.toBeNull();
		expect(issue.title).toBe('Onboard new agent: Data Engineer');
		expect(issue.labels).toContain('hire');
		expect(approval).not.toBeNull();
		expect(approval.type).toBe('hire');
		expect(approval.status).toBe('pending');
		expect(approval.payload.title).toBe('Data Engineer');
		expect(approval.payload.slug).toBe('data-engineer');
		expect(approval.payload.system_prompt).toBe('Draft prompt');
		expect(approval.payload.issue_id).toBe(issue.id);

		// No member_agent should exist yet
		const agentsRes = await app.request(`/api/companies/${companyId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await agentsRes.json()).data;
		expect(agents.find((a: Record<string, unknown>) => a.slug === 'data-engineer')).toBeUndefined();
	});

	it('resolving the hire approval materializes the agent and closes the ticket', async () => {
		const onboardRes = await app.request(`/api/companies/${companyId}/agents/onboard`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				title: 'Payments Engineer',
				role_description: 'Owns payments integration',
				system_prompt: 'Draft prompt',
				monthly_budget_cents: 7500,
				heartbeat_interval_min: 45,
			}),
		});
		const { approval, issue } = (await onboardRes.json()).data;

		const resolveRes = await app.request(`/api/approvals/${approval.id}/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'approved', resolution_note: 'looks good' }),
		});
		expect(resolveRes.status).toBe(200);

		const agentsRes = await app.request(`/api/companies/${companyId}/agents`, {
			headers: authHeader(token),
		});
		const created = (await agentsRes.json()).data.find(
			(a: Record<string, unknown>) => a.slug === 'payments-engineer',
		);
		expect(created).toBeDefined();
		expect(created.admin_status).toBe('enabled');
		expect(created.system_prompt).toBe('Draft prompt');
		expect(created.monthly_budget_cents).toBe(7500);
		expect(created.heartbeat_interval_min).toBe(45);

		const issueRes = await app.request(`/api/companies/${companyId}/issues/${issue.id}`, {
			headers: authHeader(token),
		});
		const updatedIssue = (await issueRes.json()).data;
		expect(updatedIssue.status).toBe('done');
	});

	it('denying the hire approval leaves no agent behind', async () => {
		const onboardRes = await app.request(`/api/companies/${companyId}/agents/onboard`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Dropped Role', role_description: 'No go' }),
		});
		const { approval } = (await onboardRes.json()).data;

		await app.request(`/api/approvals/${approval.id}/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'denied', resolution_note: 'not needed right now' }),
		});

		const agentsRes = await app.request(`/api/companies/${companyId}/agents`, {
			headers: authHeader(token),
		});
		const exists = (await agentsRes.json()).data.find(
			(a: Record<string, unknown>) => a.slug === 'dropped-role',
		);
		expect(exists).toBeUndefined();
	});

	it('rejects a second pending hire for the same slug', async () => {
		const first = await app.request(`/api/companies/${companyId}/agents/onboard`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Growth Marketer', role_description: 'x' }),
		});
		expect(first.status).toBe(201);

		const dup = await app.request(`/api/companies/${companyId}/agents/onboard`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Growth Marketer', role_description: 'y' }),
		});
		expect(dup.status).toBe(409);
	});

	it('bootstrap: with no CEO, creates the agent enabled without an approval', async () => {
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

		// Disable the CEO so hasCeo becomes false
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
			body: JSON.stringify({ title: 'Solo Agent', role_description: 'Works independently' }),
		});
		expect(res.status).toBe(201);
		const { agent, issue, approval, bootstrap } = (await res.json()).data;
		expect(bootstrap).toBe(true);
		expect(agent.admin_status).toBe('enabled');
		expect(issue).toBeNull();
		expect(approval).toBeNull();
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

	it('rejects onboard with duplicate slug against existing agent', async () => {
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

	it('sets and clears model_override_provider + model_override_model', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const agent = agents.find((a: Record<string, unknown>) => a.slug === 'architect');

		const set = await app.request(`/api/companies/${companyId}/agents/${agent.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model_override_provider: 'openai',
				model_override_model: 'gpt-5-mini',
			}),
		});
		expect(set.status).toBe(200);
		const setBody = await set.json();
		expect(setBody.data.model_override_provider).toBe('openai');
		expect(setBody.data.model_override_model).toBe('gpt-5-mini');

		const clear = await app.request(`/api/companies/${companyId}/agents/${agent.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ model_override_provider: null }),
		});
		expect(clear.status).toBe(200);
		const clearBody = await clear.json();
		expect(clearBody.data.model_override_provider).toBeNull();
		expect(clearBody.data.model_override_model).toBeNull();
	});

	it('rejects an unknown provider in model_override_provider', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/agents`, {
			headers: authHeader(token),
		});
		const agent = (await listRes.json()).data[0];

		const res = await app.request(`/api/companies/${companyId}/agents/${agent.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ model_override_provider: 'nope' }),
		});
		expect(res.status).toBe(400);
	});

	it('rejects a model without an existing or new provider', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		// Pick an agent with no override set; ensure cleared first.
		const agent = agents[0];
		await app.request(`/api/companies/${companyId}/agents/${agent.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ model_override_provider: null }),
		});

		const res = await app.request(`/api/companies/${companyId}/agents/${agent.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ model_override_model: 'gpt-5' }),
		});
		expect(res.status).toBe(400);
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
