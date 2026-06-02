import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/lib/types';
import { isNewer } from '../src/routes/updates';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

describe('isNewer (semver comparison)', () => {
	it('detects a strictly greater version', () => {
		expect(isNewer('0.2.0', '0.1.0')).toBe(true);
		expect(isNewer('1.0.0', '0.9.9')).toBe(true);
		expect(isNewer('0.1.1', '0.1.0')).toBe(true);
	});

	it('returns false for equal or older versions', () => {
		expect(isNewer('0.1.0', '0.1.0')).toBe(false);
		expect(isNewer('0.1.0', '0.2.0')).toBe(false);
		expect(isNewer('1.0.0', '1.0.1')).toBe(false);
	});

	it('returns false for unparseable versions', () => {
		expect(isNewer('v0.2.0', '0.1.0')).toBe(false);
		expect(isNewer('garbage', '0.1.0')).toBe(false);
	});
});

describe('GET /api/updates/latest', () => {
	let app: Hono<Env>;
	let db: Awaited<ReturnType<typeof createTestApp>>['db'];
	let token: string;

	beforeAll(async () => {
		const ctx = await createTestApp();
		app = ctx.app;
		db = ctx.db;
		token = ctx.token;
	});

	afterAll(async () => {
		await safeClose(db);
	});

	it('reports an available update from the latest GitHub release', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					tag_name: '9.9.9',
					html_url: 'https://github.com/hezo-ai/hezo/releases/9.9.9',
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			),
		);
		try {
			const res = await app.request('/api/updates/latest', { headers: authHeader(token) });
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.latest).toBe('9.9.9');
			expect(body.updateAvailable).toBe(true);
			expect(body.url).toContain('releases/9.9.9');
			expect(typeof body.current).toBe('string');
		} finally {
			fetchSpy.mockRestore();
		}
	});
});
