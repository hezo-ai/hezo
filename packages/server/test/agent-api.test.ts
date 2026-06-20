import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, mintAgentToken } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let adminToken: string;
let agentToken: string;
let teamId: string;
let projectId: string;
let projectSlug: string;
let taskId: string;
let agentId: string;
let masterKeyManager: MasterKeyManager;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	adminToken = ctx.token;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(adminToken) });
	const teamTemplateId = (await typesRes.json()).data.find((t: any) => t.name === 'Startup').id;

	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'Agent API Co',

			template_id: teamTemplateId,
		}),
	});
	const teamData = (await teamRes.json()).data;
	teamId = teamData.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Agent API Project',
		description: 'Test project.',
	});
	const projectData = (await projectRes.json()).data;
	projectId = projectData.id;
	projectSlug = projectData.slug;

	const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		headers: authHeader(adminToken),
	});
	agentId = (await agentsRes.json()).data[0].id;

	const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectId,
			title: 'Agent Test Task',
			assignee_id: agentId,
		}),
	});
	taskId = (await taskRes.json()).data.id;

	masterKeyManager = ctx.masterKeyManager;
	({ token: agentToken } = await mintAgentToken(db, masterKeyManager, agentId, teamId, taskId));
});

afterAll(async () => {
	await safeClose(db);
});

describe('agent API - heartbeat', () => {
	it('returns agent info and assigned tasks', async () => {
		const res = await app.request('/agent-api/heartbeat', {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.agent.id).toBe(agentId);
		expect(body.data.agent.runtime_status).toBe('idle');
		expect(body.data.agent.admin_status).toBe('enabled');
		expect(body.data.agent.budget_remaining_cents).toBeGreaterThan(0);
		expect(body.data.assigned_tasks.length).toBe(1);
		expect(body.data.assigned_tasks[0].id).toBe(taskId);
	});

	it('rejects admin token', async () => {
		const res = await app.request('/agent-api/heartbeat', {
			method: 'POST',
			headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(401);
	});
});

describe('agent API - comments', () => {
	it('posts a text comment', async () => {
		const res = await app.request(`/agent-api/tasks/${taskId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: 'text',
				content: { text: 'Starting work on this task.' },
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.content_type).toBe('text');
		expect(body.data.author_member_id).toBe(agentId);
	});
});

describe('agent API - tool calls', () => {
	let commentId: string;

	beforeAll(async () => {
		const res = await app.request(`/agent-api/tasks/${taskId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: 'trace',
				content: { text: 'Running tests...' },
			}),
		});
		commentId = (await res.json()).data.id;
	});

	it('reports tool calls', async () => {
		const res = await app.request(`/agent-api/tasks/${taskId}/comments/${commentId}/tool-calls`, {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				tool_calls: [
					{
						tool_name: 'bash',
						input: { command: 'npm test' },
						output: { exit_code: 0, stdout: 'all tests pass' },
						status: 'success',
						duration_ms: 3400,
						cost_cents: 0,
					},
				],
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.length).toBe(1);
		expect(body.data[0].tool_name).toBe('bash');
	});
});

describe('agent API - secrets', () => {
	it('requests a secret', async () => {
		const res = await app.request('/agent-api/secrets/request', {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				secret_name: 'GITHUB_TOKEN',
				reason: 'Need to push to feature branch',
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.approval_id).toBeTruthy();
		expect(body.data.status).toBe('pending');
	});

	it('lists granted secrets (none initially)', async () => {
		const res = await app.request('/agent-api/secrets/mine', {
			headers: authHeader(agentToken),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toEqual([]);
	});
});

describe('agent API - heartbeat edge cases', () => {
	it('updates last_heartbeat_at on heartbeat', async () => {
		const before = await db.query<{ last_heartbeat_at: string }>(
			'SELECT last_heartbeat_at FROM member_agents WHERE id = $1',
			[agentId],
		);

		await app.request('/agent-api/heartbeat', {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});

		const after = await db.query<{ last_heartbeat_at: string }>(
			'SELECT last_heartbeat_at FROM member_agents WHERE id = $1',
			[agentId],
		);
		expect(after.rows[0].last_heartbeat_at).not.toEqual(before.rows[0].last_heartbeat_at);
	});

	it('returns empty tasks when agent is disabled', async () => {
		await app.request(`/api/projects/${projectSlug}/agents/${agentId}/disable`, {
			method: 'POST',
			headers: authHeader(adminToken),
		});

		const res = await app.request('/agent-api/heartbeat', {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.agent.admin_status).toBe('disabled');
		expect(body.data.assigned_tasks).toEqual([]);

		await app.request(`/api/projects/${projectSlug}/agents/${agentId}/enable`, {
			method: 'POST',
			headers: authHeader(adminToken),
		});
	});
});

describe('agent API - self system prompt (removed)', () => {
	it('self system-prompt endpoints are gone', async () => {
		const getRes = await app.request('/agent-api/self/system-prompt', {
			headers: authHeader(agentToken),
		});
		expect(getRes.status).toBe(404);

		const patchRes = await app.request('/agent-api/self/system-prompt', {
			method: 'PATCH',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ system_prompt: 'x', reason: 'y' }),
		});
		expect(patchRes.status).toBe(404);
	});
});

describe('agent API - tool call cost reporting', () => {
	it('records tool-call cost for display only — no cost_entry, no debit, no pause', async () => {
		const agentRes = await app.request(`/api/projects/${projectSlug}/agents`, {
			method: 'POST',
			headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Budget Test Agent', monthly_budget_cents: 10 }),
		});
		const cheapAgent = (await agentRes.json()).data;
		const { token: cheapToken } = await mintAgentToken(
			db,
			masterKeyManager,
			cheapAgent.id,
			teamId,
			taskId,
			{ projectId },
		);

		await app.request(`/api/projects/${projectSlug}/tasks/${taskId}`, {
			method: 'PATCH',
			headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ assignee_id: cheapAgent.id }),
		});

		const commentRes = await app.request(`/agent-api/tasks/${taskId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(cheapToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content_type: 'trace', content: { text: 'Working...' } }),
		});
		const commentId = (await commentRes.json()).data.id;

		// Tool-call cost far exceeds the agent's tiny monthly limit, but the tool-call
		// endpoint no longer debits or enforces — run completion is the single cost
		// source (the run total already includes tool-call cost). So this succeeds and
		// the agent stays active; spend is enforced at run completion / pre-run gate.
		const res = await app.request(`/agent-api/tasks/${taskId}/comments/${commentId}/tool-calls`, {
			method: 'POST',
			headers: { ...authHeader(cheapToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				tool_calls: [{ tool_name: 'expensive_op', status: 'success', cost_cents: 9999 }],
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data[0].cost_cents).toBe(9999);

		// No cost_entry was created from the tool-call path (avoids double counting).
		const entries = await db.query<{ count: string }>(
			'SELECT count(*)::int AS count FROM cost_entries WHERE member_id = $1',
			[cheapAgent.id],
		);
		expect(Number(entries.rows[0].count)).toBe(0);

		const agentCheck = await db.query<{ runtime_status: string }>(
			'SELECT runtime_status FROM member_agents WHERE id = $1',
			[cheapAgent.id],
		);
		expect(agentCheck.rows[0].runtime_status).not.toBe('paused');

		await app.request(`/api/projects/${projectSlug}/tasks/${taskId}`, {
			method: 'PATCH',
			headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ assignee_id: agentId }),
		});
	});
});
