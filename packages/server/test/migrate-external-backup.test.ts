import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryDb } from '../src/db/client';
import type { Db } from '../src/db/database';
import type { PgliteDb } from '../src/db/drivers/pglite';
import { readLogicalBackupHeader } from '../src/db/logical-backup';
import { ExternalDbError } from '../src/db/migrate-errors';
import { applyPendingMigrationsExternal, MIGRATION_LOCK_KEY } from '../src/db/migrate-external';

// The backup + lock-race branches of the external migrator. The core apply /
// downgrade-guard / resume behaviour lives in database-external-migrations.test.ts.

const V1 = 'CREATE TABLE ext_bk_posts (id INT PRIMARY KEY, title TEXT NOT NULL);';
const V2 = "INSERT INTO ext_bk_posts (id, title) VALUES (1, 'seeded by 002');";

describe('applyPendingMigrationsExternal — pre-migration backup', () => {
	let db: PgliteDb;

	beforeEach(async () => {
		db = await createMemoryDb();
	});
	afterEach(async () => {
		await db.close();
	});

	it('writes a logical backup before migrating and prunes old ones to the retention cap', async () => {
		// Baseline first (the startup path always has _migrations by upgrade time).
		await applyPendingMigrationsExternal(db, { '001_posts.sql': V1 });
		await db.query("INSERT INTO ext_bk_posts (id, title) VALUES (42, 'pre-upgrade row')");

		const dir = await mkdtemp(join(tmpdir(), 'hezo-ext-backup-'));
		// Seven pre-existing backups, named to sort before the fresh timestamped one.
		for (let i = 0; i < 7; i++) {
			await writeFile(join(dir, `hezo-000${i}-pre-0.0.${i}.backup.gz`), 'old');
		}

		await applyPendingMigrationsExternal(
			db,
			{ '001_posts.sql': V1, '002_seed.sql': V2 },
			{ backup: { dir, version: '9.9.9' } },
		);

		// The migration itself landed.
		const rows = await db.query<{ c: number }>('SELECT COUNT(*)::int AS c FROM ext_bk_posts');
		expect(rows.rows[0].c).toBe(2);

		// Exactly 5 backups retained, the newest being the one just written.
		const files = (await readdir(dir)).sort();
		expect(files).toHaveLength(5);
		const fresh = files.filter((f) => f.includes('-pre-9.9.9.backup.gz'));
		expect(fresh).toHaveLength(1);
		// The oldest pre-existing ones were pruned; the most recent old ones survive.
		expect(files).not.toContain('hezo-0000-pre-0.0.0.backup.gz');
		expect(files).toContain('hezo-0006-pre-0.0.6.backup.gz');

		// The backup is a readable v1 logical backup taken at the pre-migration
		// schema (only tables that existed before 002 ran, minus _migrations).
		const header = readLogicalBackupHeader(await readFile(join(dir, fresh[0])));
		expect(header).not.toBeNull();
		expect(header?.hezoVersion).toBe('9.9.9');
		expect(header?.migrations.map((m) => m.filename)).toEqual(['001_posts.sql']);
		expect(header?.tables.map((t) => t.name)).toContain('ext_bk_posts');
	});

	it('aborts the migration entirely when the backup cannot be written', async () => {
		await applyPendingMigrationsExternal(db, { '001_posts.sql': V1 });

		// A file where the backup directory should be → mkdir fails deterministically.
		const parent = await mkdtemp(join(tmpdir(), 'hezo-ext-badbk-'));
		const notADir = join(parent, 'blocker');
		await writeFile(notADir, 'i am a file');
		const dir = join(notADir, 'backups');

		await expect(
			applyPendingMigrationsExternal(
				db,
				{ '001_posts.sql': V1, '002_seed.sql': V2 },
				{ backup: { dir, version: '9.9.9' } },
			),
		).rejects.toBeInstanceOf(ExternalDbError);

		// Fail-safe: 002 was never applied and the lock was released.
		const rows = await db.query<{ c: number }>('SELECT COUNT(*)::int AS c FROM ext_bk_posts');
		expect(rows.rows[0].c).toBe(0);
		const applied = await db.query<{ filename: string }>('SELECT filename FROM _migrations');
		expect(applied.rows.map((r) => r.filename)).toEqual(['001_posts.sql']);
		const lock = await db.query<{ held: boolean }>('SELECT pg_advisory_unlock($1) AS held', [
			MIGRATION_LOCK_KEY,
		]);
		expect(lock.rows[0].held).toBe(false);
	});

	it('skips the backup and apply when another instance migrated while we waited on the lock', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'hezo-ext-race-'));
		await mkdir(dir, { recursive: true });

		// Deterministic race: the pre-check sees 001 pending, but by the time the
		// lock is granted a "faster instance" (the wrapper) has already applied it.
		const { runMigrations } = await import('../src/db/migrate');
		const wrapped: Db = Object.create(db);
		wrapped.acquireSessionLock = async (key: number) => {
			const lock = await db.acquireSessionLock(key);
			await runMigrations(db, { '001_posts.sql': V1 });
			return lock;
		};

		await applyPendingMigrationsExternal(
			wrapped,
			{ '001_posts.sql': V1 },
			{ backup: { dir, version: '9.9.9' } },
		);

		// Applied exactly once (by the racing instance), and — because there was
		// nothing left to do — no backup was written by this instance.
		const applied = await db.query<{ filename: string }>('SELECT filename FROM _migrations');
		expect(applied.rows.map((r) => r.filename)).toEqual(['001_posts.sql']);
		expect(await readdir(dir)).toEqual([]);
		const lock = await db.query<{ held: boolean }>('SELECT pg_advisory_unlock($1) AS held', [
			MIGRATION_LOCK_KEY,
		]);
		expect(lock.rows[0].held).toBe(false);
	});
});
