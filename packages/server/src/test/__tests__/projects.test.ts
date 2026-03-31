import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let app: Hono;
let db: PGlite;
let token: string;
let companyId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Project Test Co', issue_prefix: 'PTC' }),
	});
	companyId = (await companyRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('projects CRUD', () => {
	it('creates a project', async () => {
		const res = await app.request(`/api/companies/${companyId}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Backend API', goal: 'Ship fast' }),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.name).toBe('Backend API');
		expect(body.data.company_id).toBe(companyId);
	});

	it('lists projects with counts', async () => {
		const res = await app.request(`/api/companies/${companyId}/projects`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(1);
		expect(body.data[0]).toHaveProperty('repo_count');
		expect(body.data[0]).toHaveProperty('open_issue_count');
	});

	it('gets a project by id with repos', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/projects`, {
			headers: authHeader(token),
		});
		const project = (await listRes.json()).data[0];

		const res = await app.request(`/api/companies/${companyId}/projects/${project.id}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toHaveProperty('repos');
	});

	it('updates a project', async () => {
		const listRes = await app.request(`/api/companies/${companyId}/projects`, {
			headers: authHeader(token),
		});
		const project = (await listRes.json()).data[0];

		const res = await app.request(`/api/companies/${companyId}/projects/${project.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ goal: 'Updated goal' }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.goal).toBe('Updated goal');
	});

	it('deletes a project with no open issues', async () => {
		const createRes = await app.request(`/api/companies/${companyId}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Temp Project' }),
		});
		const project = (await createRes.json()).data;

		const res = await app.request(`/api/companies/${companyId}/projects/${project.id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
	});
});
