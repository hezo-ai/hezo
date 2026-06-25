import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

// Isolated file: getLatestInfo memoizes for an hour, so the network-failure path
// must run against a cold cache with no successful fetch ahead of it. A dedicated
// file gives this its own fresh module instance (vitest isolates per file).

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

describe('GET /updates/latest — network failure fails soft', () => {
	it('reports no update (latest=null) when the GitHub release check throws', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.github.com'));
		try {
			const res = await app.request('/api/updates/latest', { headers: authHeader(token) });
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.latest).toBeNull();
			expect(body.updateAvailable).toBe(false);
			expect(body.url).toBeNull();
			expect(typeof body.current).toBe('string');
		} finally {
			fetchSpy.mockRestore();
		}
	});
});
