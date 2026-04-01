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
});
