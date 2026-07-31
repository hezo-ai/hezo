import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let nonSuperuserToken: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	const nonAdmin = await db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('Regular Admin', false) RETURNING id",
	);
	nonSuperuserToken = await signAdminJwt(ctx.masterKeyManager, nonAdmin.rows[0].id);
});

afterAll(async () => {
	await safeClose(db);
});

function get(authToken: string) {
	return app.request('/api/sandbox-backend-info', { headers: authHeader(authToken) });
}

describe('GET /api/sandbox-backend-info', () => {
	it('reports the local Docker default', async () => {
		const res = await get(token);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			data: { backend: 'docker', display: 'local Docker daemon' },
		});
	});

	it('rejects non-superusers', async () => {
		// Even redacted, the provider endpoint is infrastructure detail - the same
		// posture as /api/database-info and /api/asset-storage-info.
		expect((await get(nonSuperuserToken)).status).toBe(403);
	});

	it('rejects an unauthenticated request', async () => {
		expect((await app.request('/api/sandbox-backend-info')).status).toBe(401);
	});

	it('exposes no way to change the backend', async () => {
		// Read-only by design: the backend is deployment configuration, chosen once
		// at startup and never changed at runtime, so there is nothing to PATCH.
		for (const method of ['PATCH', 'POST', 'PUT', 'DELETE']) {
			const res = await app.request('/api/sandbox-backend-info', {
				method,
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ backend: 'daytona' }),
			});
			expect(res.status).toBe(404);
		}
	});
});
