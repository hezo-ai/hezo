import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let app: Hono;
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
		body: JSON.stringify({ name: 'Comment Co', issue_prefix: 'CC' }),
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

describe('comments CRUD', () => {
	it('creates a text comment', async () => {
		const res = await app.request(`/api/companies/${companyId}/issues/${issueId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: 'text',
				content: { text: 'Hello world' },
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.content_type).toBe('text');
		expect(body.data.content.text).toBe('Hello world');
	});

	it('lists comments in order', async () => {
		// Add another comment
		await app.request(`/api/companies/${companyId}/issues/${issueId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: 'text',
				content: { text: 'Second comment' },
			}),
		});

		const res = await app.request(`/api/companies/${companyId}/issues/${issueId}/comments`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(2);
		// Ordered by created_at ASC
		expect(body.data[0].content.text).toBe('Hello world');
	});

	it('creates an options comment and chooses an option', async () => {
		const createRes = await app.request(`/api/companies/${companyId}/issues/${issueId}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: 'options',
				content: {
					prompt: 'Which approach?',
					options: [
						{ id: 'a', label: 'Option A' },
						{ id: 'b', label: 'Option B' },
					],
				},
			}),
		});
		expect(createRes.status).toBe(201);
		const comment = (await createRes.json()).data;

		const chooseRes = await app.request(
			`/api/companies/${companyId}/issues/${issueId}/comments/${comment.id}/choose`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ chosen_id: 'a' }),
			},
		);
		expect(chooseRes.status).toBe(200);
		const chosenBody = await chooseRes.json();
		expect(chosenBody.data.chosen_option.chosen_id).toBe('a');
	});
});
