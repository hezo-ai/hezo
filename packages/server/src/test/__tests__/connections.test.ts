import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MasterKeyManager } from '../../crypto/master-key';
import { signOAuthState } from '../../crypto/state';
import type { Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;
let companyId: string;
let companySlug: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	// Create a company for testing
	const typesRes = await app.request('/api/company-types', { headers: authHeader(token) });
	const types = (await typesRes.json()).data;
	const builtinTypeId = types.find((t: Record<string, unknown>) => t.name === 'Startup').id;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Connection Test Co', template_id: builtinTypeId }),
	});
	const companyBody = (await companyRes.json()).data;
	companyId = companyBody.id;
	companySlug = companyBody.slug;
});

afterAll(async () => {
	await safeClose(db);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('connections CRUD', () => {
	it('lists connections (empty initially)', async () => {
		const res = await app.request(`/api/companies/${companyId}/connections`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toEqual([]);
	});

	it('starts OAuth flow and returns auth_url', async () => {
		const res = await app.request(`/api/companies/${companyId}/connections/github/start`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.auth_url).toContain('http://localhost:4100/auth/github/start');
		expect(body.data.auth_url).toContain('callback=');
		expect(body.data.state).toBeTruthy();
	});

	it('rejects unsupported platform', async () => {
		const res = await app.request(`/api/companies/${companyId}/connections/slack/start`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('UNSUPPORTED_PLATFORM');
	});

	describe('OAuth callback', () => {
		it('exchanges code via Connect and creates connection on valid callback', async () => {
			const state = await signOAuthState({ company_id: companyId }, masterKeyManager);
			const metadata = Buffer.from(
				JSON.stringify({
					username: 'test-bot',
					avatar_url: 'https://example.com/avatar',
					email: 'test@example.com',
				}),
			).toString('base64url');

			// Mock the Connect exchange endpoint
			const originalFetch = globalThis.fetch;
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
				const url =
					typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
				if (url.includes('/auth/exchange')) {
					return new Response(
						JSON.stringify({
							access_token: 'gho_test_token',
							scopes: 'repo,workflow',
							metadata,
							platform: 'github',
						}),
						{ status: 200, headers: { 'Content-Type': 'application/json' } },
					);
				}
				return originalFetch(input, init);
			});

			const res = await app.request(
				`/oauth/callback?platform=github&code=test-exchange-code&state=${encodeURIComponent(state)}`,
			);

			expect(res.status).toBe(302);
			const location = res.headers.get('Location')!;
			expect(location).toContain(`/companies/${companySlug}/issues/`);
			expect(location).not.toContain(companyId);

			// Verify connection was created
			const connRes = await app.request(`/api/companies/${companyId}/connections`, {
				headers: authHeader(token),
			});
			const connections = (await connRes.json()).data;
			expect(connections.length).toBe(1);
			expect(connections[0].platform).toBe('github');
			expect(connections[0].status).toBe('active');
			expect(connections[0].scopes).toBe('repo,workflow');
			expect(connections[0].metadata.username).toBe('test-bot');

			// Verify a CEO-assigned OAuth verification ticket was created in Operations
			const verifyRes = await db.query<{
				identifier: string;
				assignee_slug: string;
				project_slug: string;
			}>(
				`SELECT i.identifier, ma.slug AS assignee_slug, p.slug AS project_slug
				 FROM issues i
				 JOIN projects p ON p.id = i.project_id
				 LEFT JOIN member_agents ma ON ma.id = i.assignee_id
				 WHERE i.company_id = $1 AND i.labels @> '["oauth-verification"]'::jsonb`,
				[companyId],
			);
			expect(verifyRes.rows.length).toBe(1);
			expect(verifyRes.rows[0].assignee_slug).toBe('ceo');
			expect(verifyRes.rows[0].project_slug).toBe('operations');
			expect(location).toContain(verifyRes.rows[0].identifier);
		});

		it('returns 400 for invalid state', async () => {
			const res = await app.request(
				'/oauth/callback?platform=github&code=token&state=invalid.state',
			);
			expect(res.status).toBe(400);
		});

		it('returns 400 for missing state', async () => {
			const res = await app.request('/oauth/callback?platform=github&code=token');
			expect(res.status).toBe(400);
		});

		it('redirects on error param', async () => {
			const res = await app.request('/oauth/callback?error=access_denied&platform=github&state=x');
			expect(res.status).toBe(302);
			expect(res.headers.get('Location')).toContain('error');
		});

		it('returns 400 for missing code', async () => {
			const state = await signOAuthState({ company_id: companyId }, masterKeyManager);
			const res = await app.request(
				`/oauth/callback?platform=github&state=${encodeURIComponent(state)}`,
			);
			expect(res.status).toBe(400);
		});
	});

	describe('disconnect', () => {
		it('disconnects a platform and removes connection', async () => {
			// Get the connection ID first
			const connRes = await app.request(`/api/companies/${companyId}/connections`, {
				headers: authHeader(token),
			});
			const connections = (await connRes.json()).data;
			const connectionId = connections[0].id;

			const res = await app.request(`/api/companies/${companyId}/connections/${connectionId}`, {
				method: 'DELETE',
				headers: authHeader(token),
			});
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.data.deleted).toBe(true);

			// Verify connection is gone
			const afterRes = await app.request(`/api/companies/${companyId}/connections`, {
				headers: authHeader(token),
			});
			const afterConnections = (await afterRes.json()).data;
			expect(afterConnections.length).toBe(0);
		});

		it('returns 404 for non-existent connection', async () => {
			const res = await app.request(
				`/api/companies/${companyId}/connections/00000000-0000-0000-0000-000000000000`,
				{ method: 'DELETE', headers: authHeader(token) },
			);
			expect(res.status).toBe(404);
		});
	});

	describe('refresh', () => {
		it('returns 404 for non-existent connection', async () => {
			const res = await app.request(
				`/api/companies/${companyId}/connections/00000000-0000-0000-0000-000000000000/refresh`,
				{ method: 'POST', headers: authHeader(token) },
			);
			expect(res.status).toBe(404);
		});
	});
});
