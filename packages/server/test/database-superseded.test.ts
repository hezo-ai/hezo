import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuthType } from '@hezo/shared';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { buildDatabaseInfoRoutes } from '../src/routes/database-info';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

// Three snapshot dirs, each PG_VERSION ('16\n' = 3 bytes) + base/data (500 bytes)
// = 503 bytes, so 3 total 1509 bytes. Names are real timestamped forms so the
// oldest-first sort is exercised.
const SNAPSHOTS = [
	'pgdata.superseded.2026-07-20T07-16-44-887Z',
	'pgdata.superseded.2026-07-21T03-58-39-807Z',
	'pgdata.superseded.2026-07-22T09-06-19-601Z',
];
const BYTES_PER_SNAPSHOT = 503;

describe('database superseded snapshots', () => {
	let app: Hono<Env>;
	let db: Db;
	let token: string;
	let masterKeyManager: MasterKeyManager;
	let dataDir: string;

	function seedSnapshot(name: string): void {
		const dir = join(dataDir, name);
		mkdirSync(join(dir, 'base'), { recursive: true });
		writeFileSync(join(dir, 'PG_VERSION'), '16\n'); // 3 bytes
		writeFileSync(join(dir, 'base', 'data'), 'x'.repeat(500)); // 500 bytes, nested
	}

	beforeAll(async () => {
		const ctx = await createTestApp();
		app = ctx.app;
		db = ctx.db;
		token = ctx.token;
		masterKeyManager = ctx.masterKeyManager;
		dataDir = ctx.dataDir;
	});

	afterAll(async () => {
		await safeClose(db);
		rmSync(dataDir, { recursive: true, force: true });
	});

	it('reports zero when there are no snapshots', async () => {
		const res = await app.request('/api/database-info/superseded', { headers: authHeader(token) });
		expect(res.status).toBe(200);
		const { data } = (await res.json()) as { data: { count: number; bytes: number } };
		expect(data).toEqual({ count: 0, bytes: 0 });
	});

	it('measures the count and total on-disk size of the snapshots', async () => {
		for (const name of SNAPSHOTS) seedSnapshot(name);

		const res = await app.request('/api/database-info/superseded', { headers: authHeader(token) });
		expect(res.status).toBe(200);
		const { data } = (await res.json()) as { data: { count: number; bytes: number } };
		expect(data.count).toBe(SNAPSHOTS.length);
		expect(data.bytes).toBe(SNAPSHOTS.length * BYTES_PER_SNAPSHOT);
	});

	it('requires superuser for both the size lookup and the prune', async () => {
		const nonSuper = await db.query<{ id: string }>(
			"INSERT INTO users (display_name, is_superuser) VALUES ('Member', false) RETURNING id",
		);
		const memberToken = await signAdminJwt(masterKeyManager, nonSuper.rows[0].id);

		const sizeRes = await app.request('/api/database-info/superseded', {
			headers: authHeader(memberToken),
		});
		expect(sizeRes.status).toBe(403);

		const pruneRes = await app.request('/api/database-info/prune-superseded', {
			method: 'POST',
			headers: authHeader(memberToken),
		});
		expect(pruneRes.status).toBe(403);

		// The 403 must not have deleted anything.
		const stillThere = await app.request('/api/database-info/superseded', {
			headers: authHeader(token),
		});
		const { data } = (await stillThere.json()) as { data: { count: number } };
		expect(data.count).toBe(SNAPSHOTS.length);
	});

	it('prunes every snapshot and reports the disk it freed', async () => {
		const res = await app.request('/api/database-info/prune-superseded', {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const { data } = (await res.json()) as { data: { removed: number; freed_bytes: number } };
		expect(data.removed).toBe(SNAPSHOTS.length);
		expect(data.freed_bytes).toBe(SNAPSHOTS.length * BYTES_PER_SNAPSHOT);

		// Nothing left to reclaim afterwards.
		const after = await app.request('/api/database-info/superseded', {
			headers: authHeader(token),
		});
		const body = (await after.json()) as { data: { count: number; bytes: number } };
		expect(body.data).toEqual({ count: 0, bytes: 0 });
	});
});

// The external-Postgres backend produces no snapshots. Build the routes directly
// with an external StorageInfo behind a stub superuser auth so the branch is
// covered without provisioning a real external database.
describe('database superseded snapshots — external backend', () => {
	function externalApp(dataDir: string): Hono<Env> {
		const app = new Hono<Env>();
		app.use('*', async (c, next) => {
			c.set('auth', { type: AuthType.Admin, userId: 'stub', isSuperuser: true });
			await next();
		});
		app.route(
			'/api',
			buildDatabaseInfoRoutes({ backend: 'external', display: 'postgres://x' }, dataDir),
		);
		return app;
	}

	it('reports zero and refuses to prune', async () => {
		const app = externalApp('/nonexistent-data-dir');

		const size = await app.request('/api/database-info/superseded');
		expect(size.status).toBe(200);
		const { data } = (await size.json()) as { data: { count: number; bytes: number } };
		expect(data).toEqual({ count: 0, bytes: 0 });

		const prune = await app.request('/api/database-info/prune-superseded', { method: 'POST' });
		expect(prune.status).toBe(409);
	});
});
