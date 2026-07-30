import { AuthType } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { createTestApp } from './helpers/app';

const BYPASS_TOKEN = 'mcp-concurrency-probe';

// Every /mcp request resolves its principal with a DB round-trip first, and the
// test database serialises those, so requests here would otherwise queue up and
// never overlap. Resolving this one token without touching the DB lets several
// requests reach the transport at the same time, which is what a pooled
// production database does and what the shared-transport fix has to survive.
vi.mock('../src/middleware/auth', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../src/middleware/auth')>();
	return {
		...actual,
		verifyToken: async (...args: Parameters<typeof actual.verifyToken>) =>
			args[0] === BYPASS_TOKEN
				? { type: AuthType.Admin, userId: 'mcp-concurrency-probe', isSuperuser: true }
				: actual.verifyToken(...args),
	};
});

let app: Hono<Env>;
let db: Db;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
});

afterAll(async () => {
	await safeClose(db);
});

it('serves overlapping requests over one shared transport', async () => {
	const responses = await Promise.all(
		Array.from({ length: 8 }, (_, i) =>
			app.request('/mcp', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${BYPASS_TOKEN}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: i }),
			}),
		),
	);

	// Linking a fresh client/server pair per request made every request after the
	// first fail to attach and then stall waiting for an initialize reply, so a
	// regression shows up as an error body or a timeout rather than a bad value.
	for (const [i, res] of responses.entries()) {
		expect(res.status, `request ${i}`).toBe(200);
		const body = await res.json();
		expect(body.error, `request ${i}`).toBeUndefined();
		expect(body.result.tools.length, `request ${i}`).toBeGreaterThan(0);
	}
});
