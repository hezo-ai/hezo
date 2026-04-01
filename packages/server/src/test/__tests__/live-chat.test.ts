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
let issueId: string;
let agentSlug: string;
let agentId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Chat Co', issue_prefix: 'CHT' }),
	});
	companyId = (await companyRes.json()).data.id;

	const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Main' }),
	});
	const projectId = (await projectRes.json()).data.id;

	const issueRes = await app.request(`/api/companies/${companyId}/issues`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title: 'Test Issue' }),
	});
	issueId = (await issueRes.json()).data.id;

	// Create an agent for mention testing
	const agentRes = await app.request(`/api/companies/${companyId}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Chat Bot' }),
	});
	const agent = (await agentRes.json()).data;
	agentId = agent.id;
	agentSlug = agent.slug;
});

afterAll(async () => {
	await safeClose(db);
});

describe('live chat', () => {
	it('returns empty messages when no chat exists', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues/${issueId}/chat/messages`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toEqual([]);
	});

	it('creates a chat message and returns it', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues/${issueId}/chat/messages`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: 'Hello, agent!' }),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.content).toBe('Hello, agent!');
		expect(body.data.author_type).toBe('board');
	});

	it('lists messages after creation', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues/${issueId}/chat/messages`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(1);
		expect(body.data[0].content).toBe('Hello, agent!');
	});

	it('rejects empty content', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues/${issueId}/chat/messages`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: '' }),
		});
		expect(res.status).toBe(400);
	});

	it('creates a wakeup when message mentions an agent', async () => {
		// Clear existing wakeups
		await db.query('DELETE FROM agent_wakeup_requests WHERE company_id = $1', [companyId]);

		const res = await app.request(`/api/companies/${companyId}/issues/${issueId}/chat/messages`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: `Hey @${agentSlug} please review this` }),
		});
		expect(res.status).toBe(201);

		// Allow async wakeup creation to complete
		await new Promise((r) => setTimeout(r, 100));

		const wakeups = await db.query(
			"SELECT * FROM agent_wakeup_requests WHERE member_id = $1 AND source = 'chat_message'",
			[agentId],
		);
		expect(wakeups.rows.length).toBeGreaterThanOrEqual(1);
	});

	it('does not create a wakeup for messages without mentions', async () => {
		await db.query('DELETE FROM agent_wakeup_requests WHERE company_id = $1', [companyId]);

		const res = await app.request(`/api/companies/${companyId}/issues/${issueId}/chat/messages`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: 'Just a regular message' }),
		});
		expect(res.status).toBe(201);

		await new Promise((r) => setTimeout(r, 100));

		const wakeups = await db.query(
			"SELECT * FROM agent_wakeup_requests WHERE company_id = $1 AND source = 'chat_message'",
			[companyId],
		);
		expect(wakeups.rows.length).toBe(0);
	});
});
