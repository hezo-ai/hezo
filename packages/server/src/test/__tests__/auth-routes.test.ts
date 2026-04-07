import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Env } from '../../lib/types';
import { verifyToken } from '../../middleware/auth';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let masterKeyHex: string;
let masterKeyManager: MasterKeyManager;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	masterKeyHex = ctx.masterKeyHex;
	masterKeyManager = ctx.masterKeyManager;
});

afterAll(async () => {
	await safeClose(db);
});

describe('POST /api/auth/token', () => {
	it('returns 400 when master_key is missing', async () => {
		const res = await app.request('/api/auth/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('INVALID_REQUEST');
	});

	it('returns 401 for invalid master key', async () => {
		const res = await app.request('/api/auth/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ master_key: 'wrong_key_value' }),
		});
		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body.error.code).toBe('UNAUTHORIZED');
	});

	it('returns a valid JWT for correct master key', async () => {
		const res = await app.request('/api/auth/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ master_key: masterKeyHex }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toHaveProperty('token');
		expect(typeof body.data.token).toBe('string');

		// Verify the returned token is valid
		const auth = await verifyToken(body.data.token, db, masterKeyManager);
		expect(auth).not.toBeNull();
		expect(auth!.type).toBe('board');
	});

	it('reuses existing superuser on subsequent calls', async () => {
		const res1 = await app.request('/api/auth/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ master_key: masterKeyHex }),
		});
		const token1 = (await res1.json()).data.token;
		const auth1 = await verifyToken(token1, db, masterKeyManager);

		const res2 = await app.request('/api/auth/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ master_key: masterKeyHex }),
		});
		const token2 = (await res2.json()).data.token;
		const auth2 = await verifyToken(token2, db, masterKeyManager);

		// Both tokens should reference the same user
		expect(auth1).not.toBeNull();
		expect(auth2).not.toBeNull();
		if (auth1!.type === 'board' && auth2!.type === 'board') {
			expect(auth1!.userId).toBe(auth2!.userId);
		}
	});

	it('returned token grants access to protected endpoints', async () => {
		const res = await app.request('/api/auth/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ master_key: masterKeyHex }),
		});
		const { token } = (await res.json()).data;

		const companiesRes = await app.request('/api/companies', {
			headers: authHeader(token),
		});
		expect(companiesRes.status).toBe(200);
	});
});
