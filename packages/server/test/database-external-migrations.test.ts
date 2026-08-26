import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryDb } from '../src/db/client';
import type { Db, Queryable } from '../src/db/database';
import type { PgliteDb } from '../src/db/drivers/pglite';
import { PostgresDb } from '../src/db/drivers/postgres';
import { MIGRATION_LOCK_KEY, runMigrations } from '../src/db/migrate';
import { DbNewerThanAppError, ExternalMigrationFailedError } from '../src/db/migrate-errors';
import { applyPendingMigrationsExternal } from '../src/db/migrate-external';
import { BASE_SCHEMA } from '../src/db/schema';
import { createTestDbWithMigrations } from './helpers/db';
import { allMigrations } from './helpers/migrate';
import { introspectSchema } from './helpers/schema-introspect';
import { createScratchPostgres } from './helpers/scratch-postgres';

// Orchestrator logic runs against PGlite through the generic Db interface —
// pg_advisory_xact_lock and the _migrations bookkeeping are core Postgres. The
// concurrency behaviour across real separate connections (two pools racing the
// lock) is covered by the env-gated postgres leg in CI.

const V1 = 'CREATE TABLE ext_posts (id INT PRIMARY KEY, title TEXT NOT NULL);';
const V2 = "INSERT INTO ext_posts (id, title) VALUES (1, 'seeded by 002');";

describe('applyPendingMigrationsExternal', () => {
	let db: PgliteDb;

	/**
	 * Advisory locks still held.
	 *
	 * A transaction-scoped lock cannot be released by `pg_advisory_unlock`, which
	 * only ever unlocks session locks - asking that way would answer false
	 * whether or not the lock was held, which is a test that cannot fail.
	 */
	async function advisoryLocksHeld(): Promise<number> {
		const r = await db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM pg_locks
			 WHERE locktype = 'advisory' AND objid = $1
			   AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
			[MIGRATION_LOCK_KEY],
		);
		return r.rows[0].c;
	}

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

	it('holds no lock after a successful run', async () => {
		await applyPendingMigrationsExternal(db, { '001_posts.sql': V1 });
		expect(await advisoryLocksHeld()).toBe(0);
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
		// the lock": delegate to the real driver, but have the first transaction
		// commit a migration this binary does not know before the guard reads. The
		// pre-check already passed on a clean database, so only the re-check under
		// the lock can catch it.
		const wrapped: Db = Object.create(db);
		let injected = false;
		wrapped.transaction = async <T>(cb: (tx: Queryable) => Promise<T>): Promise<T> => {
			if (!injected) {
				injected = true;
				await db.exec(`
					CREATE TABLE IF NOT EXISTS _migrations (
						id SERIAL PRIMARY KEY, filename TEXT NOT NULL UNIQUE,
						applied_at TIMESTAMPTZ NOT NULL DEFAULT now(), checksum TEXT NOT NULL
					);
					INSERT INTO _migrations (filename, checksum) VALUES ('999_from_the_future.sql', 'x');
				`);
			}
			return db.transaction(cb);
		};

		await expect(
			applyPendingMigrationsExternal(wrapped, { '001_posts.sql': V1 }),
		).rejects.toBeInstanceOf(DbNewerThanAppError);
		// 001 was never applied — the guard fired before runMigrations…
		const applied = await db.query<{ filename: string }>('SELECT filename FROM _migrations');
		expect(applied.rows.map((r) => r.filename)).toEqual(['999_from_the_future.sql']);
		// …and the rolled-back guard transaction took its lock with it.
		expect(await advisoryLocksHeld()).toBe(0);
	});

	// The lock is per transaction, so it is not held across the run: a newer binary
	// can win it partway through and migrate the database past us. Without a check
	// after the run this binary finishes happily and goes on to serve requests
	// against a schema it does not know - which is the whole thing the downgrade
	// guard exists to prevent, so it must refuse rather than reason about it.
	it('refuses when a newer binary migrated past us DURING the run', async () => {
		const wrapped: Db = Object.create(db);
		let transactions = 0;
		wrapped.transaction = async <T>(cb: (tx: Queryable) => Promise<T>): Promise<T> => {
			transactions += 1;
			const result = await db.transaction(cb);
			// 1 = the pre-run guard, 2 = migration 001. A newer binary wins the lock
			// once 001 has committed and applies something we have never heard of.
			if (transactions === 2) {
				await db.exec(`
					INSERT INTO _migrations (filename, checksum)
					VALUES ('999_from_the_future.sql', 'x');
				`);
			}
			return result;
		};

		await expect(
			applyPendingMigrationsExternal(wrapped, { '001_posts.sql': V1 }),
		).rejects.toBeInstanceOf(DbNewerThanAppError);
		// Ours still committed - the refusal is about what happens next, not a
		// rollback of work already durably applied.
		const applied = await db.query<{ filename: string }>('SELECT filename FROM _migrations');
		expect(applied.rows.map((r) => r.filename)).toContain('001_posts.sql');
		expect(await advisoryLocksHeld()).toBe(0);
	});

	// The rolling-deploy shape, and the one an early return hid: the newer binary
	// applies our WHOLE pending set plus one of its own, so we find nothing left
	// to do and would have booted clean against a schema we do not know.
	it('refuses when a newer binary applied our whole pending set and more', async () => {
		const wrapped: Db = Object.create(db);
		let injected = false;
		wrapped.transaction = async <T>(cb: (tx: Queryable) => Promise<T>): Promise<T> => {
			const result = await db.transaction(cb);
			if (!injected) {
				injected = true;
				await runMigrations(db, { '001_posts.sql': V1 });
				await db.exec(`
					INSERT INTO _migrations (filename, checksum)
					VALUES ('999_from_the_future.sql', 'x');
				`);
			}
			return result;
		};

		await expect(
			applyPendingMigrationsExternal(wrapped, { '001_posts.sql': V1 }),
		).rejects.toBeInstanceOf(DbNewerThanAppError);
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
		expect(await advisoryLocksHeld()).toBe(0);

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

		// The dense-deployment setting. It only works because the migration lock is
		// transaction-scoped: a session-scoped one needs a connection of its own,
		// and with a pool of one there is no second connection to give it.
		it('starts and migrates on a pool of one', async () => {
			const scratch = await createScratchPostgres('extpool1');
			const external = await PostgresDb.connect({ url: scratch.url, max: 1 });
			try {
				await external.exec(BASE_SCHEMA);
				const migrations = allMigrations();
				await applyPendingMigrationsExternal(external, migrations);
				const total = await external.query<{ c: number }>(
					'SELECT COUNT(*)::int AS c FROM _migrations',
				);
				expect(total.rows[0].c).toBe(Object.keys(migrations).length);
			} finally {
				await external.close();
				await scratch.drop();
			}
		});

		// Removing the session lock must not have removed the guarantee it existed
		// for, and a pool of one is where a lost lock would show up first.
		it('applies each migration exactly once when two pools of one race', async () => {
			const scratch = await createScratchPostgres('extrace1');
			const a = await PostgresDb.connect({ url: scratch.url, max: 1 });
			const b = await PostgresDb.connect({ url: scratch.url, max: 1 });
			try {
				await a.exec(BASE_SCHEMA);
				const migrations = allMigrations();
				await Promise.all([
					applyPendingMigrationsExternal(a, migrations),
					applyPendingMigrationsExternal(b, migrations),
				]);
				const duplicated = await a.query<{ filename: string }>(
					'SELECT filename FROM _migrations GROUP BY filename HAVING COUNT(*) > 1',
				);
				expect(duplicated.rows).toEqual([]);
				const total = await a.query<{ c: number }>('SELECT COUNT(*)::int AS c FROM _migrations');
				expect(total.rows[0].c).toBe(Object.keys(migrations).length);
			} finally {
				await a.close();
				await b.close();
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

// The property a transaction pooler needs, proven without one.
//
// A pooler breaks session state by handing the next statement a different
// backend. So rather than standing one up - a service container that could only
// be validated in CI, on a required check - this drives the migration path
// through a Db that gives every statement outside a transaction its OWN
// connection, and closes it afterwards. That is strictly more hostile than
// PgBouncer in transaction mode, which at least reuses a backend when it can.
// If migrations survive this, no pooling mode can break them.
describe.skipIf(!process.env.HEZO_TEST_DATABASE_URL)(
	'applyPendingMigrationsExternal with no session continuity at all',
	() => {
		it('migrates the full bundled sequence', async () => {
			const scratch = await createScratchPostgres('extpool');
			const real = await PostgresDb.connect({ url: scratch.url });
			try {
				await real.exec(BASE_SCHEMA);

				// Every non-transactional statement lands on a connection that has
				// never been used before and is discarded after.
				const hostile: Db = Object.create(real);
				const onFreshConnection = async <T>(run: (c: pg.Client) => Promise<T>): Promise<T> => {
					const client = new pg.Client({ connectionString: scratch.url });
					await client.connect();
					try {
						return await run(client);
					} finally {
						await client.end();
					}
				};
				hostile.query = ((sql: string, params?: unknown[]) =>
					onFreshConnection((c) => c.query(sql, params as never))) as Db['query'];
				hostile.exec = ((sql: string) =>
					onFreshConnection(async (c) => {
						await c.query(sql);
					})) as Db['exec'];

				const migrations = allMigrations();
				await applyPendingMigrationsExternal(hostile, migrations);

				const total = await real.query<{ c: number }>('SELECT COUNT(*)::int AS c FROM _migrations');
				expect(total.rows[0].c).toBe(Object.keys(migrations).length);
			} finally {
				await real.close();
				await scratch.drop();
			}
		});
	},
);
