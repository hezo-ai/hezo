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
	it('reports the local Docker default, plus what a switch would cost', async () => {
		const res = await get(token);
		expect(res.status).toBe(200);
		const data = (await res.json()).data;
		expect(data.backend).toBe('docker');
		expect(data.display).toBe('local Docker daemon');
		// The form needs to know which backends exist and whether a credential is
		// already on file, so it can offer "keep the saved key" rather than
		// demanding one every time.
		expect(data.available).toContain('daytona');
		expect(data.credential_configured).toBe(false);
		// The confirmation dialog names real numbers rather than warning in the
		// abstract, so the counts ship with the read.
		expect(data.impact).toEqual({ containers: 0, activeRuns: 0 });
	});

	it('never echoes the provider key back, only whether one exists', async () => {
		// The key lives in the vault and is decrypted in-process for control-plane
		// calls only. A response that carried it would put it in every client's
		// memory and in any log that captures responses.
		const body = JSON.stringify(await (await get(token)).json());
		expect(body).not.toContain('daytona_api_key');
		expect(body).not.toContain('dtn_');
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
