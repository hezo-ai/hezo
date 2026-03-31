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

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'API Key Co', issue_prefix: 'AKC' }),
	});
	companyId = (await companyRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('API keys CRUD', () => {
	it('creates an API key and returns raw key once', async () => {
		const res = await app.request(`/api/companies/${companyId}/api-keys`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Test Key' }),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.key).toMatch(/^hezo_/);
		expect(body.data.name).toBe('Test Key');
		expect(body.data.prefix).toHaveLength(8);
	});

	it('lists API keys (without raw key)', async () => {
		const res = await app.request(`/api/companies/${companyId}/api-keys`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(1);
		// Raw key should NOT be in list
		expect(body.data[0]).not.toHaveProperty('key');
		expect(body.data[0]).not.toHaveProperty('key_hash');
	});

	it('authenticates with an API key', async () => {
		// Create a key
		const createRes = await app.request(`/api/companies/${companyId}/api-keys`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Auth Test Key' }),
		});
		const rawKey = (await createRes.json()).data.key;

		// Use the key to access an API
		const res = await app.request(`/api/companies/${companyId}/api-keys`, {
			headers: { Authorization: `Bearer ${rawKey}` },
		});
		expect(res.status).toBe(200);
	});

	it('revokes an API key', async () => {
		const createRes = await app.request(`/api/companies/${companyId}/api-keys`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'To Revoke' }),
		});
		const apiKey = (await createRes.json()).data;
		const rawKey = apiKey.key;

		const res = await app.request(`/api/companies/${companyId}/api-keys/${apiKey.id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);

		// Verify key no longer works
		const authRes = await app.request(`/api/companies/${companyId}/api-keys`, {
			headers: { Authorization: `Bearer ${rawKey}` },
		});
		expect(authRes.status).toBe(401);
	});
});
