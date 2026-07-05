import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryDb } from '../src/db/client';
import type { Db } from '../src/db/database';
import type { PgliteDb } from '../src/db/drivers/pglite';
import { PostgresDb } from '../src/db/drivers/postgres';
import { DbNewerThanAppError, ExternalMigrationFailedError } from '../src/db/migrate-errors';
import { applyPendingMigrationsExternal, MIGRATION_LOCK_KEY } from '../src/db/migrate-external';
import { BASE_SCHEMA } from '../src/db/schema';
import { createTestDbWithMigrations } from './helpers/db';
import { allMigrations } from './helpers/migrate';
import { introspectSchema } from './helpers/schema-introspect';
import { createScratchPostgres } from './helpers/scratch-postgres';

// Orchestrator logic runs against PGlite through the generic Db interface —
// pg_advisory_lock and the _migrations bookkeeping are core Postgres. The
// concurrency behaviour across real separate connections (two pools racing the
// lock) is covered by the env-gated postgres leg in CI.

const V1 = 'CREATE TABLE ext_posts (id INT PRIMARY KEY, title TEXT NOT NULL);';
const V2 = "INSERT INTO ext_posts (id, title) VALUES (1, 'seeded by 002');";

describe('applyPendingMigrationsExternal', () => {
	let db: PgliteDb;

	beforeEach(async () => {
		db = await createMemoryDb();
	});
	afterEach(async () => {
		await db.close();
	});

	it('applies pending migrations in place and is idempotent on re-run', async () => {
		const migrations = { '001_posts.sql': V1, '002_seed.sql': V2 };
		await applyPendingMigrationsExternal(db, migrations);

		const rows = await db.query<{ title: string }>('SELECT title FROM ext_posts');
		expect(rows.rows).toEqual([{ title: 'seeded by 002' }]);
		const applied = await db.query<{ filename: string }>(
			'SELECT filename FROM _migrations ORDER BY id',
		);
		expect(applied.rows.map((r) => r.filename)).toEqual(['001_posts.sql', '002_seed.sql']);

		// Second run: nothing pending, no error, no duplicate application.
		await applyPendingMigrationsExternal(db, migrations);
		const recount = await db.query<{ c: number }>('SELECT COUNT(*)::int AS c FROM ext_posts');
		expect(recount.rows[0].c).toBe(1);
	});

	it('releases the migration lock after a successful run', async () => {
		await applyPendingMigrationsExternal(db, { '001_posts.sql': V1 });
		// Unlocking a lock we do not hold reports false — proves the runner released it.
		const r = await db.query<{ held: boolean }>('SELECT pg_advisory_unlock($1) AS held', [
			MIGRATION_LOCK_KEY,
		]);
		expect(r.rows[0].held).toBe(false);
	});

	it('refuses to run when the database is newer than the binary', async () => {
		await applyPendingMigrationsExternal(db, {
			'001_posts.sql': V1,
			'002_future.sql': 'CREATE TABLE ext_future (id INT);',
		});
		// This binary only knows 001 — and 002 is already recorded as applied.
		await expect(
			applyPendingMigrationsExternal(db, { '001_posts.sql': V1 }),
		).rejects.toBeInstanceOf(DbNewerThanAppError);
	});

	it('re-checks the downgrade guard under the lock', async () => {
		// Deterministically simulate "a newer instance migrated while we waited on
		// the lock": delegate to the real driver but make acquiring the lock also
		// record a migration this binary doesn't know. The pre-check passes (clean
		// DB, 001 pending), so only the under-lock re-check can catch it.
		const wrapped: Db = Object.create(db);
		wrapped.acquireSessionLock = async (key: number) => {
			const lock = await db.acquireSessionLock(key);
			await db.exec(`
				CREATE TABLE IF NOT EXISTS _migrations (
					id SERIAL PRIMARY KEY, filename TEXT NOT NULL UNIQUE,
					applied_at TIMESTAMPTZ NOT NULL DEFAULT now(), checksum TEXT NOT NULL
				);
				INSERT INTO _migrations (filename, checksum) VALUES ('999_from_the_future.sql', 'x');
			`);
			return lock;
		};

		await expect(
			applyPendingMigrationsExternal(wrapped, { '001_posts.sql': V1 }),
		).rejects.toBeInstanceOf(DbNewerThanAppError);
		// 001 was never applied — the guard fired before runMigrations…
		const applied = await db.query<{ filename: string }>('SELECT filename FROM _migrations');
		expect(applied.rows.map((r) => r.filename)).toEqual(['999_from_the_future.sql']);
		// …and the guard did not leave the lock held.
		const r = await db.query<{ held: boolean }>('SELECT pg_advisory_unlock($1) AS held', [
			MIGRATION_LOCK_KEY,
		]);
		expect(r.rows[0].held).toBe(false);
	});

	it('keeps the applied prefix and resumes after a failed migration', async () => {
		await expect(
			applyPendingMigrationsExternal(db, {
				'001_posts.sql': V1,
				'002_bad.sql': 'THIS IS NOT VALID SQL;',
			}),
		).rejects.toBeInstanceOf(ExternalMigrationFailedError);

		// 001 committed durably; the failed 002 rolled back; the lock is free.
		const applied = await db.query<{ filename: string }>('SELECT filename FROM _migrations');
		expect(applied.rows.map((r) => r.filename)).toEqual(['001_posts.sql']);
		const lock = await db.query<{ held: boolean }>('SELECT pg_advisory_unlock($1) AS held', [
			MIGRATION_LOCK_KEY,
		]);
		expect(lock.rows[0].held).toBe(false);

		// A re-run with the fixed 002 resumes from where it failed.
		await applyPendingMigrationsExternal(db, { '001_posts.sql': V1, '002_seed.sql': V2 });
		const rows = await db.query<{ c: number }>('SELECT COUNT(*)::int AS c FROM ext_posts');
		expect(rows.rows[0].c).toBe(1);
	});
});

// Env-gated: the real bundled migration sequence against a real Postgres
// (the test-postgres CI job's postgres:16 service). Proves the shipped SQL
// replays on hosted PG and produces a schema identical to PGlite's, and that
// two separate pools racing the runner apply each migration exactly once.
describe.skipIf(!process.env.HEZO_TEST_DATABASE_URL)(
	'applyPendingMigrationsExternal against real Postgres',
	() => {
		it('replays the full bundled sequence and matches the PGlite schema exactly', async () => {
			const scratch = await createScratchPostgres('extmig');
			const external = await PostgresDb.connect({ url: scratch.url });
			try {
				await external.exec(BASE_SCHEMA);
				await applyPendingMigrationsExternal(external, allMigrations());

				const pglite = await createTestDbWithMigrations();
				try {
					const [pgSchema, pgliteSchema] = await Promise.all([
						introspectSchema(external),
						introspectSchema(pglite),
					]);
					expect(pgSchema).toBe(pgliteSchema);
				} finally {
					await pglite.close();
				}
			} finally {
				await external.close();
				await scratch.drop();
			}
		});

		it('applies each migration exactly once when two pools race the runner', async () => {
			const scratch = await createScratchPostgres('extrace');
			const a = await PostgresDb.connect({ url: scratch.url });
			const b = await PostgresDb.connect({ url: scratch.url });
			try {
				await a.exec(BASE_SCHEMA);
				const migrations = allMigrations();
				await Promise.all([
					applyPendingMigrationsExternal(a, migrations),
					applyPendingMigrationsExternal(b, migrations),
				]);
				const applied = await a.query<{ filename: string; n: number }>(
					'SELECT filename, COUNT(*)::int AS n FROM _migrations GROUP BY filename HAVING COUNT(*) > 1',
				);
				expect(applied.rows).toEqual([]);
				const total = await a.query<{ c: number }>('SELECT COUNT(*)::int AS c FROM _migrations');
				expect(total.rows[0].c).toBe(Object.keys(migrations).length);
			} finally {
				await a.close();
				await b.close();
				await scratch.drop();
			}
		});
	},
);
