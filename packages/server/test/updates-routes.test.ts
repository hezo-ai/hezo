import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

describe('update routes (status / download / apply)', () => {
	let app: Hono<Env>;
	let db: Awaited<ReturnType<typeof createTestApp>>['db'];
	let superToken: string;
	let userToken: string;

	beforeAll(async () => {
		const ctx = await createTestApp();
		app = ctx.app;
		db = ctx.db;
		superToken = ctx.token;
		// A second, non-superuser user.
		const u = await db.query<{ id: string }>(
			"INSERT INTO users (display_name, is_superuser) VALUES ('Member', false) RETURNING id",
		);
		userToken = await signAdminJwt(ctx.masterKeyManager, u.rows[0].id);

		// Keep the GitHub release check off the network and deterministic.
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					tag_name: '9.9.9',
					html_url: 'https://github.com/hezo-ai/hezo/releases/9.9.9',
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			),
		);
	});

	afterAll(async () => {
		vi.restoreAllMocks();
		await safeClose(db);
	});

	it('GET /updates/status returns lifecycle + autoUnlock for any authed user', async () => {
		const res = await app.request('/api/updates/status', { headers: authHeader(userToken) });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.updateAvailable).toBe(true);
		expect(body.state).toBe('idle');
		// createTestApp configures no master key, so the instance does not auto-unlock.
		expect(body.autoUnlock).toBe(false);
		// Tests don't run as a supervised compiled binary.
		expect(body.canApply).toBe(false);
	});

	it('POST /updates/download requires superuser', async () => {
		const res = await app.request('/api/updates/download', {
			method: 'POST',
			headers: authHeader(userToken),
		});
		expect(res.status).toBe(403);
	});

	it('POST /updates/download is 409 when auto-update is unavailable (not supervised)', async () => {
		const res = await app.request('/api/updates/download', {
			method: 'POST',
			headers: authHeader(superToken),
		});
		expect(res.status).toBe(409);
	});

	it('POST /updates/apply requires superuser', async () => {
		const res = await app.request('/api/updates/apply', {
			method: 'POST',
			headers: authHeader(userToken),
		});
		expect(res.status).toBe(403);
	});

	it('POST /updates/apply is 409 when auto-update is unavailable (not supervised)', async () => {
		const res = await app.request('/api/updates/apply', {
			method: 'POST',
			headers: authHeader(superToken),
		});
		expect(res.status).toBe(409);
	});
});
