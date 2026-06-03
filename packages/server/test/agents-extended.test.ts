import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let teamId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/team-templates', {
		headers: authHeader(token),
	});
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'Startup',
	).id;

	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'Extended Agent Test Co',
			template_id: typeId,
		}),
	});
	teamId = (await teamRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('POST /teams/:teamId/agents/onboard', () => {
	it('creates a hire approval and Captain ticket, but no agent yet', async () => {
		const res = await app.request(`/api/teams/${teamId}/agents/onboard`, {
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
		const { agent, task, approval, bootstrap } = body.data;

		expect(bootstrap).toBe(false);
		expect(agent).toBeNull();
		expect(task).not.toBeNull();
		expect(task.title).toBe('Onboard new agent: Data Engineer');
		expect(task.labels).toContain('hire');
		expect(approval).not.toBeNull();
		expect(approval.type).toBe('hire');
		expect(approval.status).toBe('pending');
		expect(approval.payload.title).toBe('Data Engineer');
		expect(approval.payload.slug).toBe('data-engineer');
		expect(approval.payload.system_prompt).toBe('Draft prompt');
		expect(approval.payload.task_id).toBe(task.id);

		// No member_agent should exist yet
		const agentsRes = await app.request(`/api/teams/${teamId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await agentsRes.json()).data;
		expect(agents.find((a: Record<string, unknown>) => a.slug === 'data-engineer')).toBeUndefined();
	});

	it('resolving the hire approval materializes the agent and closes the ticket', async () => {
		const onboardRes = await app.request(`/api/teams/${teamId}/agents/onboard`, {
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
		const { approval, task } = (await onboardRes.json()).data;

		const resolveRes = await app.request(`/api/approvals/${approval.id}/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'approved', resolution_note: 'looks good' }),
		});
		expect(resolveRes.status).toBe(200);

		const agentsRes = await app.request(`/api/teams/${teamId}/agents`, {
			headers: authHeader(token),
		});
		const created = (await agentsRes.json()).data.find(
			(a: Record<string, unknown>) => a.slug === 'payments-engineer',
		);
		expect(created).toBeDefined();
		expect(created.admin_status).toBe('enabled');
		expect(created.monthly_budget_cents).toBe(7500);
		expect(created.heartbeat_interval_min).toBe(45);
		// Hire flow does not surface run_timeout_min; it falls back to the DB default.
		expect(created.run_timeout_min).toBe(60);

		const promptRes = await app.request(`/api/teams/${teamId}/agents/${created.id}/system-prompt`, {
			headers: authHeader(token),
		});
		expect((await promptRes.json()).data.content).toBe('Draft prompt');

		const taskRes = await app.request(`/api/teams/${teamId}/tasks/${task.id}`, {
			headers: authHeader(token),
		});
		const updatedTask = (await taskRes.json()).data;
		expect(updatedTask.status).toBe('done');
	});

	it('denying the hire approval leaves no agent behind', async () => {
		const onboardRes = await app.request(`/api/teams/${teamId}/agents/onboard`, {
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

		const agentsRes = await app.request(`/api/teams/${teamId}/agents`, {
			headers: authHeader(token),
		});
		const exists = (await agentsRes.json()).data.find(
			(a: Record<string, unknown>) => a.slug === 'dropped-role',
		);
		expect(exists).toBeUndefined();
	});

	it('rejects a second pending hire for the same slug', async () => {
		const first = await app.request(`/api/teams/${teamId}/agents/onboard`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Growth Marketer', role_description: 'x' }),
		});
		expect(first.status).toBe(201);

		const dup = await app.request(`/api/teams/${teamId}/agents/onboard`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Growth Marketer', role_description: 'y' }),
		});
		expect(dup.status).toBe(409);
	});

	it('bootstrap: with no Captain, creates the agent enabled without an approval', async () => {
		const typesRes = await app.request('/api/team-templates', {
			headers: authHeader(token),
		});
		const typeId = (await typesRes.json()).data.find(
			(t: Record<string, unknown>) => t.name === 'Startup',
		).id;

		const bareRes = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'No Captain Co', template_id: typeId }),
		});
		const bareTeamId = (await bareRes.json()).data.id;

		// Disable the Captain so hasCaptain becomes false
		const agentsRes = await app.request(`/api/teams/${bareTeamId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await agentsRes.json()).data;
		const captain = agents.find((a: Record<string, unknown>) => a.slug === 'captain');
		await app.request(`/api/teams/${bareTeamId}/agents/${captain.id}/disable`, {
			method: 'POST',
			headers: authHeader(token),
		});

		const res = await app.request(`/api/teams/${bareTeamId}/agents/onboard`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Solo Agent', role_description: 'Works independently' }),
		});
		expect(res.status).toBe(201);
		const { agent, task, approval, bootstrap } = (await res.json()).data;
		expect(bootstrap).toBe(true);
		expect(agent.admin_status).toBe('enabled');
		expect(task).toBeNull();
		expect(approval).toBeNull();
	});

	it('rejects onboard with missing title', async () => {
		const res = await app.request(`/api/teams/${teamId}/agents/onboard`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ role_description: 'Missing title field' }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('INVALID_REQUEST');
	});

	it('rejects onboard with duplicate slug against existing agent', async () => {
		// Captain slug already exists from the Startup template
		const res = await app.request(`/api/teams/${teamId}/agents/onboard`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Captain' }),
		});
		expect(res.status).toBe(409);
		const body = await res.json();
		expect(body.error.code).toBe('CONFLICT');
	});
});

describe('seeded agent system prompts', () => {
	it('every Startup-template agent gets a non-empty system prompt with templating preserved', async () => {
		const agentsRes = await app.request(`/api/teams/${teamId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await agentsRes.json()).data as Array<{ id: string; slug: string }>;

		const seededSlugs = [
			'captain',
			'architect',
			'product-lead',
			'engineer',
			'qa-engineer',
			'ui-designer',
			'devops-engineer',
			'marketing-lead',
			'researcher',
			'security-engineer',
			'coach',
		];

		const getPrompt = async (agentId: string): Promise<string> => {
			const res = await app.request(`/api/teams/${teamId}/agents/${agentId}/system-prompt`, {
				headers: authHeader(token),
			});
			return ((await res.json()).data?.content ?? '') as string;
		};

		for (const slug of seededSlugs) {
			const agent = agents.find((a) => a.slug === slug);
			expect(agent, `agent ${slug} should exist on the seeded team`).toBeDefined();
			const prompt = await getPrompt(agent!.id);
			expect(prompt, `agent ${slug} should have a system prompt`).toBeTruthy();
			expect(prompt.length).toBeGreaterThan(100);
		}

		const captain = agents.find((a) => a.slug === 'captain')!;
		const ceoPrompt = await getPrompt(captain.id);
		expect(ceoPrompt).toContain('You are the Captain of');
		expect(ceoPrompt).toContain('{{team_name}}');
		expect(ceoPrompt).toMatch(/##\s+Rules\b/);

		const engineer = agents.find((a) => a.slug === 'engineer')!;
		const engineerPrompt = await getPrompt(engineer.id);
		expect(engineerPrompt).toContain('You are an Engineer at');
		expect(engineerPrompt).toContain('{{reports_to}}');
	});
});

describe('agent listing with admin_status filter', () => {
	it('filters by multiple statuses with comma-separated query param', async () => {
		// Disable one agent so we have both enabled and disabled agents
		const agentsRes = await app.request(`/api/teams/${teamId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await agentsRes.json()).data;
		const target = agents.find((a: Record<string, unknown>) => a.slug === 'engineer');

		await app.request(`/api/teams/${teamId}/agents/${target.id}/disable`, {
			method: 'POST',
			headers: authHeader(token),
		});

		const res = await app.request(`/api/teams/${teamId}/agents?admin_status=enabled,disabled`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		const statuses = new Set(body.data.map((a: Record<string, unknown>) => a.admin_status));
		expect(statuses.has('enabled')).toBe(true);
		expect(statuses.has('disabled')).toBe(true);
		// Re-enable so other tests aren't affected
		await app.request(`/api/teams/${teamId}/agents/${target.id}/enable`, {
			method: 'POST',
			headers: authHeader(token),
		});
	});

	it('returns empty array when filter matches no agents', async () => {
		const res = await app.request(`/api/teams/${teamId}/agents?admin_status=disabled`, {
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
		const res = await app.request(`/api/teams/${teamId}/agents`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		// Every entry must expose reports_to (may be null)
		for (const agent of body.data) {
			expect(agent).toHaveProperty('reports_to');
		}
		// At least one agent reports to the Captain
		const withReportsTo = body.data.filter((a: Record<string, unknown>) => a.reports_to !== null);
		expect(withReportsTo.length).toBeGreaterThan(0);
		// Those agents should also have reports_to_title populated
		for (const agent of withReportsTo) {
			expect(typeof agent.reports_to_title).toBe('string');
			expect(agent.reports_to_title.length).toBeGreaterThan(0);
		}
	});
});

describe('PATCH /teams/:teamId/agents/:agentId (partial updates)', () => {
	it('updates only role_description leaving other fields unchanged', async () => {
		const listRes = await app.request(`/api/teams/${teamId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const agent = agents.find((a: Record<string, unknown>) => a.slug === 'architect');

		const originalTitle = agent.title;
		const originalBudget = agent.monthly_budget_cents;

		const res = await app.request(`/api/teams/${teamId}/agents/${agent.id}`, {
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
		const listRes = await app.request(`/api/teams/${teamId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const agent = agents.find((a: Record<string, unknown>) => a.slug === 'architect');

		const res = await app.request(`/api/teams/${teamId}/agents/${agent.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ system_prompt: 'New system prompt for Architect.' }),
		});
		expect(res.status).toBe(200);

		const promptRes = await app.request(`/api/teams/${teamId}/agents/${agent.id}/system-prompt`, {
			headers: authHeader(token),
		});
		const promptDoc = (await promptRes.json()).data;
		expect(promptDoc.content).toBe('New system prompt for Architect.');

		const revisionsRes = await app.request(
			`/api/teams/${teamId}/agents/${agent.id}/system-prompt/revisions`,
			{ headers: authHeader(token) },
		);
		const revisions = (await revisionsRes.json()).data as Array<{
			content: string;
			change_summary: string;
		}>;
		expect(revisions.length).toBeGreaterThanOrEqual(1);
		expect(revisions[0].change_summary).toBe('Manual edit by the admin');
	});

	it('updates title and syncs display_name on the members record', async () => {
		const listRes = await app.request(`/api/teams/${teamId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const agent = agents.find((a: Record<string, unknown>) => a.slug === 'researcher');

		const res = await app.request(`/api/teams/${teamId}/agents/${agent.id}`, {
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
		const listRes = await app.request(`/api/teams/${teamId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const agent = agents[0];

		const res = await app.request(`/api/teams/${teamId}/agents/${agent.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(200);
	});

	it('clears reports_to when patched with null', async () => {
		// Find an agent that has a reports_to set (any non-Captain)
		const listRes = await app.request(`/api/teams/${teamId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const subordinate = agents.find((a: Record<string, unknown>) => a.reports_to !== null);
		expect(subordinate).toBeDefined();

		const res = await app.request(`/api/teams/${teamId}/agents/${subordinate.id}`, {
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
		const res = await app.request(`/api/teams/${teamId}/agents/${fakeId}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ role_description: 'Ghost agent' }),
		});
		expect(res.status).toBe(404);
	});

	it('sets and clears model_override_provider + model_override_model', async () => {
		const listRes = await app.request(`/api/teams/${teamId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		const agent = agents.find((a: Record<string, unknown>) => a.slug === 'architect');

		const set = await app.request(`/api/teams/${teamId}/agents/${agent.id}`, {
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

		const clear = await app.request(`/api/teams/${teamId}/agents/${agent.id}`, {
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
		const listRes = await app.request(`/api/teams/${teamId}/agents`, {
			headers: authHeader(token),
		});
		const agent = (await listRes.json()).data[0];

		const res = await app.request(`/api/teams/${teamId}/agents/${agent.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ model_override_provider: 'nope' }),
		});
		expect(res.status).toBe(400);
	});

	it('rejects a model without an existing or new provider', async () => {
		const listRes = await app.request(`/api/teams/${teamId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await listRes.json()).data;
		// Pick an agent with no override set; ensure cleared first.
		const agent = agents[0];
		await app.request(`/api/teams/${teamId}/agents/${agent.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ model_override_provider: null }),
		});

		const res = await app.request(`/api/teams/${teamId}/agents/${agent.id}`, {
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
		const res = await app.request(`/api/teams/${teamId}/agents`, {
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

describe('PATCH /agents/:agentId run_timeout_min', () => {
	it('persists run_timeout_min independently of heartbeat_interval_min', async () => {
		const agentsRes = await app.request(`/api/teams/${teamId}/agents`, {
			headers: authHeader(token),
		});
		const architect = (await agentsRes.json()).data.find(
			(a: Record<string, unknown>) => a.slug === 'architect',
		);
		expect(architect).toBeDefined();
		const originalHeartbeat = architect.heartbeat_interval_min as number;

		const patchRes = await app.request(`/api/teams/${teamId}/agents/${architect.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ run_timeout_min: 17 }),
		});
		expect(patchRes.status).toBe(200);

		const refreshed = await app.request(`/api/teams/${teamId}/agents/${architect.id}`, {
			headers: authHeader(token),
		});
		const updated = (await refreshed.json()).data;
		expect(updated.run_timeout_min).toBe(17);
		expect(updated.heartbeat_interval_min).toBe(originalHeartbeat);
	});
});
