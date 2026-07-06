import { createServer, type Server } from 'node:http';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

// The route-level SkillsRegistryError → REGISTRY_ERROR mapping in
// /api/skills/registry/{search,install}: 4xx service errors map to 400,
// 5xx-ish (unreachable registry) map to 503. No real network: the 400 cases
// throw before any fetch, and the 503 cases point at a connection-refused port.

let app: Hono<Env>;
let db: Db;
let token: string;
const prevBaseUrl = process.env.SKILLS_REGISTRY_BASE_URL;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	// Nothing listens here — any registry call fails as connection refused (502 → 503).
	process.env.SKILLS_REGISTRY_BASE_URL = 'http://127.0.0.1:1';

	// A configured token gets the search route past the REGISTRY_TOKEN_REQUIRED gate.
	const put = await app.request('/api/skills/registry/token', {
		method: 'PUT',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ token: 'route-error-test-token' }),
	});
	expect(put.status).toBe(200);
});

afterAll(async () => {
	if (prevBaseUrl === undefined) delete process.env.SKILLS_REGISTRY_BASE_URL;
	else process.env.SKILLS_REGISTRY_BASE_URL = prevBaseUrl;
	await safeClose(db);
});

describe('GET /api/skills/registry/search error mapping', () => {
	it('maps a client-side registry error (too-short query) to 400 REGISTRY_ERROR', async () => {
		const res = await app.request('/api/skills/registry/search?q=a', {
			headers: authHeader(token),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('REGISTRY_ERROR');
		expect(body.error.message).toMatch(/at least 2 characters/);
	});

	it('maps an unreachable registry to 503 REGISTRY_ERROR', async () => {
		const res = await app.request('/api/skills/registry/search?q=react', {
			headers: authHeader(token),
		});
		expect(res.status).toBe(503);
		const body = await res.json();
		expect(body.error.code).toBe('REGISTRY_ERROR');
		expect(body.error.message).toMatch(/skills\.sh/);
	});
});

describe('POST /api/skills/registry/install error mapping', () => {
	it('maps a malformed skill id to 400 REGISTRY_ERROR', async () => {
		const res = await app.request('/api/skills/registry/install', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ id: 'not-a-valid-id' }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('REGISTRY_ERROR');
		expect(body.error.message).toMatch(/owner\/repo\/skill/);
	});

	it('maps an unreachable registry to 503 REGISTRY_ERROR and installs nothing', async () => {
		const res = await app.request('/api/skills/registry/install', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ id: 'acme/skills/react-hooks' }),
		});
		expect(res.status).toBe(503);
		expect((await res.json()).error.code).toBe('REGISTRY_ERROR');

		const rows = await db.query("SELECT 1 FROM skills WHERE slug = 'react-hooks'");
		expect(rows.rows).toHaveLength(0);
	});
});

describe('non-registry errors are rethrown to the global handler (500)', () => {
	// A registry that answers 200 with a non-JSON body: `res.json()` throws a
	// plain SyntaxError, which is NOT a SkillsRegistryError — the routes must
	// rethrow it rather than mislabel it REGISTRY_ERROR. Expected `Route error`
	// log lines: both tests assert this 500 path.
	let garbage: Server;

	beforeAll(async () => {
		garbage = createServer((_req, res) => {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end('this is not json');
		});
		await new Promise<void>((resolve) => garbage.listen(0, resolve));
		const addr = garbage.address();
		const port = typeof addr === 'object' && addr ? addr.port : 0;
		process.env.SKILLS_REGISTRY_BASE_URL = `http://127.0.0.1:${port}`;
	});

	afterAll(async () => {
		process.env.SKILLS_REGISTRY_BASE_URL = 'http://127.0.0.1:1';
		await new Promise<void>((resolve) => garbage.close(() => resolve()));
	});

	it('search: a malformed registry response surfaces as 500, not REGISTRY_ERROR', async () => {
		const res = await app.request('/api/skills/registry/search?q=react', {
			headers: authHeader(token),
		});
		expect(res.status).toBe(500);
	});

	it('install: a malformed registry response surfaces as 500 and installs nothing', async () => {
		const res = await app.request('/api/skills/registry/install', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ id: 'acme/skills/react-hooks' }),
		});
		expect(res.status).toBe(500);
		const rows = await db.query("SELECT 1 FROM skills WHERE slug = 'react-hooks'");
		expect(rows.rows).toHaveLength(0);
	});
});
