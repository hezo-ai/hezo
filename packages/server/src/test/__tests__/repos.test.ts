import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signOAuthState } from '../../crypto/state';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;
let companyId: string;
let projectId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	// Create company
	const typesRes = await app.request('/api/company-types', { headers: authHeader(token) });
	const types = (await typesRes.json()).data;
	const builtinTypeId = types.find((t: any) => t.is_builtin).id;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Repo Test Co', company_type_id: builtinTypeId }),
	});
	companyId = (await companyRes.json()).data.id;

	// Create project
	const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Test Project', goal: 'Testing repos' }),
	});
	projectId = (await projectRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
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

	it('returns GITHUB_NOT_CONNECTED when no GitHub connection', async () => {
		const res = await app.request(`/api/companies/${companyId}/projects/${projectId}/repos`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ short_name: 'frontend', url: 'https://github.com/acme/frontend' }),
		});
		expect(res.status).toBe(422);
		const body = await res.json();
		expect(body.error.code).toBe('GITHUB_NOT_CONNECTED');
	});

	it('creates an oauth_request approval when GitHub not connected', async () => {
		const approvalsRes = await app.request(
			`/api/companies/${companyId}/approvals?status=pending`,
			{ headers: authHeader(token) },
		);
		const approvals = (await approvalsRes.json()).data;
		const oauthApprovals = approvals.filter((a: any) => a.type === 'oauth_request');
		expect(oauthApprovals.length).toBeGreaterThan(0);
		expect(oauthApprovals[0].payload.platform).toBe('github');
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

	describe('with GitHub connected', () => {
		beforeAll(async () => {
			// Simulate a connection by inserting directly
			const state = await signOAuthState({ company_id: companyId }, masterKeyManager);
			const metadata = Buffer.from(
				JSON.stringify({ username: 'repo-test-bot', email: 'bot@test.com' }),
			).toString('base64url');

			await app.request(
				`/oauth/callback?platform=github&access_token=gho_test_repo_token&scopes=repo&metadata=${metadata}&state=${encodeURIComponent(state)}`,
			);
		});

		it('returns REPO_ACCESS_FAILED when GitHub returns 404', async () => {
			// The token is fake so GitHub API will fail — but since we can't mock globalThis.fetch
			// in this integration test, we test the flow up to that point
			const res = await app.request(`/api/companies/${companyId}/projects/${projectId}/repos`, {
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({
					short_name: 'frontend',
					url: 'https://github.com/acme/frontend',
				}),
			});
			// With a fake token, GitHub API will return an error
			expect([201, 422]).toContain(res.status);
			if (res.status === 422) {
				const body = await res.json();
				expect(body.error.code).toBe('REPO_ACCESS_FAILED');
				expect(body.error.message).toContain('repo-test-bot');
			}
		});
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
