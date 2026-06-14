import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSystemMeta, INSTANCE_BASE_URL_KEY } from '../src/lib/system-meta';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { safeClose } from './helpers';
import { authHeader, createTestApp, loginViaAuthApi } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let nonSuperuserToken: string;
let mnemonic: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	mnemonic = ctx.mnemonic;

	const nonAdmin = await db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('Regular Admin', false) RETURNING id",
	);
	nonSuperuserToken = await signAdminJwt(ctx.masterKeyManager, nonAdmin.rows[0].id);
});

afterAll(async () => {
	await safeClose(db);
});

function unlock(headers: Record<string, string> = {}) {
	// Base-URL capture fires from the /api/auth/verify request that completes
	// the challenge dance, so the headers land there.
	return loginViaAuthApi(app, mnemonic, { headers });
}

function patchBaseUrl(value: unknown, authToken = token) {
	return app.request('/api/instance-settings', {
		method: 'PATCH',
		headers: { ...authHeader(authToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ base_url: value }),
	});
}

async function getBaseUrl(): Promise<string | null> {
	const res = await app.request('/api/instance-settings', { headers: authHeader(token) });
	expect(res.status).toBe(200);
	return (await res.json()).data.base_url;
}

describe('GET /api/instance-settings', () => {
	it('returns null base_url on a fresh instance', async () => {
		expect(await getBaseUrl()).toBeNull();
	});
});

describe('base URL capture on unlock', () => {
	it('captures the forwarded origin on first unlock', async () => {
		const res = await unlock({ host: 'hezo.example.com', 'x-forwarded-proto': 'https' });
		expect(res.status).toBe(200);
		expect(await getSystemMeta(db, INSTANCE_BASE_URL_KEY)).toBe('https://hezo.example.com');
	});

	it('does not overwrite an already-captured value on later unlocks', async () => {
		const res = await unlock({ host: 'other.example.com', 'x-forwarded-proto': 'https' });
		expect(res.status).toBe(200);
		expect(await getSystemMeta(db, INSTANCE_BASE_URL_KEY)).toBe('https://hezo.example.com');
	});

	it('takes the first entry of a comma-separated x-forwarded-proto chain', async () => {
		await db.query('DELETE FROM system_meta WHERE key = $1', [INSTANCE_BASE_URL_KEY]);
		const res = await unlock({ host: 'chain.example.com', 'x-forwarded-proto': 'https, http' });
		expect(res.status).toBe(200);
		expect(await getSystemMeta(db, INSTANCE_BASE_URL_KEY)).toBe('https://chain.example.com');
	});

	it('defaults to http and the host header port when no proxy headers are set', async () => {
		await db.query('DELETE FROM system_meta WHERE key = $1', [INSTANCE_BASE_URL_KEY]);
		const res = await unlock({ host: 'localhost:3100' });
		expect(res.status).toBe(200);
		expect(await getSystemMeta(db, INSTANCE_BASE_URL_KEY)).toBe('http://localhost:3100');
	});
});

describe('PATCH /api/instance-settings', () => {
	it('rejects non-superusers', async () => {
		const res = await patchBaseUrl('https://x.example.com', nonSuperuserToken);
		expect(res.status).toBe(403);
	});

	it.each([
		['non-URL text', 'not a url'],
		['non-http scheme', 'ftp://x.example.com'],
		['URL with a path', 'https://x.example.com/app'],
		['URL with a query', 'https://x.example.com?q=1'],
		['URL with a fragment', 'https://x.example.com#frag'],
		['URL with credentials', 'https://user:pw@x.example.com'],
	])('rejects %s', async (_name, value) => {
		const res = await patchBaseUrl(value);
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_REQUEST');
	});

	it('rejects a non-string, non-null base_url', async () => {
		const res = await patchBaseUrl(123);
		expect(res.status).toBe(400);
	});

	it('rejects a body without base_url', async () => {
		const res = await app.request('/api/instance-settings', {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	it('normalizes to a bare origin and echoes it', async () => {
		const res = await patchBaseUrl('https://Hezo.Example.com:8443/');
		expect(res.status).toBe(200);
		expect((await res.json()).data.base_url).toBe('https://hezo.example.com:8443');
		expect(await getBaseUrl()).toBe('https://hezo.example.com:8443');
	});

	it('a manually-set value survives later unlocks', async () => {
		const res = await unlock({ host: 'fresh.example.com', 'x-forwarded-proto': 'https' });
		expect(res.status).toBe(200);
		expect(await getBaseUrl()).toBe('https://hezo.example.com:8443');
	});

	it('clears the value with null', async () => {
		const res = await patchBaseUrl(null);
		expect(res.status).toBe(200);
		expect((await res.json()).data.base_url).toBeNull();
		expect(await getBaseUrl()).toBeNull();
	});
});
