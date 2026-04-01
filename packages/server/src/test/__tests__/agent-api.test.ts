import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../lib/types';
import { signAgentJwt } from '../../middleware/auth';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let boardToken: string;
let agentToken: string;
let companyId: string;
let projectId: string;
let issueId: string;
let agentId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	boardToken = ctx.token;

	const typesRes = await app.request('/api/company-types', { headers: authHeader(boardToken) });
	const companyTypeId = (await typesRes.json()).data[0].id;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'Agent API Co',
			issue_prefix: 'AAC',
			company_type_id: companyTypeId,
		}),
	});
	companyId = (await companyRes.json()).data.id;

	const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Agent API Project' }),
	});
	projectId = (await projectRes.json()).data.id;

	const issueRes = await app.request(`/api/companies/${companyId}/issues`, {
		method: 'POST',
		headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title: 'Agent Test Issue' }),
	});
	issueId = (await issueRes.json()).data.id;

	const agentsRes = await app.request(`/api/companies/${companyId}/agents`, {
		headers: authHeader(boardToken),
	});
	agentId = (await agentsRes.json()).data[0].id;

	// Assign issue to agent
	await app.request(`/api/companies/${companyId}/issues/${issueId}`, {
		method: 'PATCH',
		headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ assignee_id: agentId }),
	});

	agentToken = await signAgentJwt(ctx.masterKeyManager, agentId, companyId);
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
		expect(body.data.agent.status).toBe('active');
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
