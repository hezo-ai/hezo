import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let companyId: string;
let projectId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	// Create company
	const typesRes = await app.request('/api/company-types', { headers: authHeader(token) });
	const types = (await typesRes.json()).data;
	const builtinTypeId = types.find((t: any) => t.name === 'Startup').id;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Repo Test Co', template_id: builtinTypeId }),
	});
	companyId = (await companyRes.json()).data.id;

	// Create project
	const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'Test Project',
			description: 'Testing repos.',
		}),
	});
	projectId = (await projectRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('repos CRUD', () => {
	it('lists repos (empty initially)', async () => {
		const res = await app.request(`/api/companies/${companyId}/projects/${projectId}/repos`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toEqual([]);
	});

	it('returns INVALID_URL for bad URLs', async () => {
		const res = await app.request(`/api/companies/${companyId}/projects/${projectId}/repos`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ short_name: 'bad', url: 'not-a-url' }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('INVALID_URL');
	});

	it('returns INVALID_REQUEST for missing fields', async () => {
		const res = await app.request(`/api/companies/${companyId}/projects/${projectId}/repos`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ short_name: 'x' }),
		});
		expect(res.status).toBe(400);
	});

	it('deletes a repo', async () => {
		// Insert a repo directly for deletion test
		const insertResult = await db.query<{ id: string }>(
			`INSERT INTO repos (project_id, short_name, repo_identifier, host_type)
			 VALUES ($1, 'to-delete', 'acme/to-delete', 'github') RETURNING id`,
			[projectId],
		);
		const repoId = insertResult.rows[0].id;

		const res = await app.request(
			`/api/companies/${companyId}/projects/${projectId}/repos/${repoId}`,
			{ method: 'DELETE', headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.deleted).toBe(true);
	});

	it('returns 404 when deleting non-existent repo', async () => {
		const res = await app.request(
			`/api/companies/${companyId}/projects/${projectId}/repos/00000000-0000-0000-0000-000000000000`,
			{ method: 'DELETE', headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});

	it('enforces unique short_name within project', async () => {
		await db.query(
			`INSERT INTO repos (project_id, short_name, repo_identifier, host_type)
			 VALUES ($1, 'unique-test', 'acme/unique-test', 'github')`,
			[projectId],
		);

		// Trying to insert the same short_name should fail at DB level
		try {
			await db.query(
				`INSERT INTO repos (project_id, short_name, repo_identifier, host_type)
				 VALUES ($1, 'unique-test', 'acme/other-repo', 'github')`,
				[projectId],
			);
			expect.fail('Should have thrown on duplicate short_name');
		} catch (e: any) {
			expect(e.message).toContain('unique');
		}
	});
});
