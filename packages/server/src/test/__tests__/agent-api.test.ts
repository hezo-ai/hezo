import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp, mintAgentToken } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let boardToken: string;
let agentToken: string;
let companyId: string;
let projectId: string;
let issueId: string;
let agentId: string;
let masterKeyManager: MasterKeyManager;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	boardToken = ctx.token;

	const typesRes = await app.request('/api/company-types', { headers: authHeader(boardToken) });
	const companyTypeId = (await typesRes.json()).data.find((t: any) => t.name === 'Startup').id;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'Agent API Co',

			template_id: companyTypeId,
		}),
	});
	companyId = (await companyRes.json()).data.id;

	const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Agent API Project', description: 'Test project.' }),
	});
	projectId = (await projectRes.json()).data.id;

	const agentsRes = await app.request(`/api/companies/${companyId}/agents`, {
		headers: authHeader(boardToken),
	});
	agentId = (await agentsRes.json()).data[0].id;

	const issueRes = await app.request(`/api/companies/${companyId}/issues`, {
		method: 'POST',
		headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectId,
			title: 'Agent Test Issue',
			assignee_id: agentId,
		}),
	});
	issueId = (await issueRes.json()).data.id;

	masterKeyManager = ctx.masterKeyManager;
	({ token: agentToken } = await mintAgentToken(db, masterKeyManager, agentId, companyId, issueId));
});

afterAll(async () => {
	await safeClose(db);
});

describe('agent API - heartbeat', () => {
	it('returns agent info and assigned issues', async () => {
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
		expect(body.data.assigned_issues.length).toBe(1);
		expect(body.data.assigned_issues[0].id).toBe(issueId);
	});

	it('rejects board token', async () => {
		const res = await app.request('/agent-api/heartbeat', {
			method: 'POST',
			headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(401);
	});
});

describe('agent API - comments', () => {
	it('posts a text comment', async () => {
		const res = await app.request(`/agent-api/issues/${issueId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: 'text',
				content: { text: 'Starting work on this issue.' },
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.content_type).toBe('text');
		expect(body.data.author_member_id).toBe(agentId);
	});

	it('posts an options comment', async () => {
		const res = await app.request(`/agent-api/issues/${issueId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: 'options',
				content: {
					prompt: 'Which approach?',
					options: [
						{ id: 'a', label: 'Option A', description: 'First approach' },
						{ id: 'b', label: 'Option B', description: 'Second approach' },
					],
				},
			}),
		});
		expect(res.status).toBe(201);
	});
});

describe('agent API - tool calls', () => {
	let commentId: string;

	beforeAll(async () => {
		const res = await app.request(`/agent-api/issues/${issueId}/comments`, {
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
		const res = await app.request(`/agent-api/issues/${issueId}/comments/${commentId}/tool-calls`, {
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

	it('returns empty issues when agent is disabled', async () => {
		await app.request(`/api/companies/${companyId}/agents/${agentId}/disable`, {
			method: 'POST',
			headers: authHeader(boardToken),
		});

		const res = await app.request('/agent-api/heartbeat', {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.agent.admin_status).toBe('disabled');
		expect(body.data.assigned_issues).toEqual([]);

		await app.request(`/api/companies/${companyId}/agents/${agentId}/enable`, {
			method: 'POST',
			headers: authHeader(boardToken),
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

describe('agent API - budget enforcement', () => {
	it('returns 402 and pauses agent when tool call exceeds budget', async () => {
		const agentRes = await app.request(`/api/companies/${companyId}/agents`, {
			method: 'POST',
			headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Budget Test Agent', monthly_budget_cents: 10 }),
		});
		const cheapAgent = (await agentRes.json()).data;
		const { token: cheapToken } = await mintAgentToken(
			db,
			masterKeyManager,
			cheapAgent.id,
			companyId,
		);

		await app.request(`/api/companies/${companyId}/issues/${issueId}`, {
			method: 'PATCH',
			headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ assignee_id: cheapAgent.id }),
		});

		const commentRes = await app.request(`/agent-api/issues/${issueId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(cheapToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content_type: 'trace', content: { text: 'Working...' } }),
		});
		const commentId = (await commentRes.json()).data.id;

		const res = await app.request(`/agent-api/issues/${issueId}/comments/${commentId}/tool-calls`, {
			method: 'POST',
			headers: { ...authHeader(cheapToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				tool_calls: [{ tool_name: 'expensive_op', status: 'success', cost_cents: 9999 }],
			}),
		});
		expect(res.status).toBe(402);
		const body = await res.json();
		expect(body.error.code).toBe('BUDGET_EXCEEDED');

		const agentCheck = await db.query<{ runtime_status: string }>(
			'SELECT runtime_status FROM member_agents WHERE id = $1',
			[cheapAgent.id],
		);
		expect(agentCheck.rows[0].runtime_status).toBe('paused');

		await app.request(`/api/companies/${companyId}/issues/${issueId}`, {
			method: 'PATCH',
			headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ assignee_id: agentId }),
		});
	});
});
