import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

/**
 * Isolated file for the same reason as `updates-fetch-error.test.ts`:
 * `getLatestInfo` memoizes for an hour at module scope, so the gate has to be
 * observed against a cold cache with no successful fetch ahead of it.
 *
 * What this pins is not really "an env var works". It is that the check makes
 * **no upstream call** when gated - which is the property the browser tier
 * depends on. The UpdateBanner sits between the app header and the content row,
 * so whether GitHub happens to be serving a release newer than this working
 * tree decides whether every element in the shell is 47px lower (75px at
 * mobile). That is a suite-wide layout change driven by a third party's release
 * schedule, and it turned the browser tier red the day 0.39.0 shipped.
 */

let app: Hono<Env>;
let db: Awaited<ReturnType<typeof createTestApp>>['db'];
let token: string;
const previous = process.env.HEZO_SKIP_UPDATE_CHECK;

beforeAll(async () => {
	process.env.HEZO_SKIP_UPDATE_CHECK = '1';
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
});

afterAll(async () => {
	if (previous === undefined) delete process.env.HEZO_SKIP_UPDATE_CHECK;
	else process.env.HEZO_SKIP_UPDATE_CHECK = previous;
	await safeClose(db);
});

describe('HEZO_SKIP_UPDATE_CHECK', () => {
	it('reports no update without calling GitHub', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		try {
			const res = await app.request('/api/updates/latest', { headers: authHeader(token) });
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.updateAvailable).toBe(false);
			expect(body.latest).toBeNull();
			expect(body.url).toBeNull();
			// Still reports the running version - the route stays useful, it just
			// never asks upstream.
			expect(typeof body.current).toBe('string');

			const upstream = fetchSpy.mock.calls.filter((c) => String(c[0]).includes('api.github.com'));
			expect(upstream).toEqual([]);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it('keeps the status route on the same answer, so the banner never renders', async () => {
		// /updates/status is what the shell polls; the banner keys off its
		// `updateAvailable`. Assert the gate reaches it too rather than only the
		// simpler /latest route.
		const res = await app.request('/api/updates/status', { headers: authHeader(token) });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.updateAvailable).toBe(false);
		expect(body.latest).toBeNull();
	});
});
