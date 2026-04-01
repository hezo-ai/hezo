import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	// Create a company for testing
	const typesRes = await app.request('/api/company-types', { headers: authHeader(token) });
	const types = (await typesRes.json()).data;
	const builtinTypeId = types.find((t: Record<string, unknown>) => t.is_builtin).id;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Connection Test Co', company_type_id: builtinTypeId }),
	});
	companyId = (await companyRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
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
		it('stores token and creates connection on valid callback', async () => {
			const state = await signOAuthState({ company_id: companyId }, masterKeyManager);
			const metadata = Buffer.from(
				JSON.stringify({
					username: 'test-bot',
					avatar_url: 'https://example.com/avatar',
					email: 'test@example.com',
				}),
			).toString('base64url');

			const res = await app.request(
				`/oauth/callback?platform=github&access_token=gho_test_token&scopes=repo,workflow&metadata=${metadata}&state=${encodeURIComponent(state)}`,
			);

			expect(res.status).toBe(302);
			const location = res.headers.get('Location')!;
			expect(location).toContain(`/companies/${companyId}/settings`);
			expect(location).toContain('connected=github');

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
		});

		it('returns 400 for invalid state', async () => {
			const res = await app.request(
				'/oauth/callback?platform=github&access_token=token&state=invalid.state',
			);
			expect(res.status).toBe(400);
		});

		it('returns 400 for missing state', async () => {
			const res = await app.request('/oauth/callback?platform=github&access_token=token');
			expect(res.status).toBe(400);
		});

		it('redirects on error param', async () => {
			const res = await app.request('/oauth/callback?error=access_denied&platform=github&state=x');
			expect(res.status).toBe(302);
			expect(res.headers.get('Location')).toContain('error');
		});

		it('returns 400 for missing access_token', async () => {
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
