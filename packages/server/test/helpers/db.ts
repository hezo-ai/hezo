import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { type Migration, runMigrations } from '../../src/db/migrate';
import { codeMigrations } from '../../src/db/migrations/code';
import { BASE_SCHEMA } from '../../src/db/schema';

/** Creates a fresh in-memory PGlite instance with base tables for testing. */
export async function createTestDb(): Promise<PGlite> {
	const db = new PGlite();
	await db.exec(BASE_SCHEMA);
	return db;
}

/** Boots a fresh PGlite and applies the full migration sequence (SQL + code). */
async function buildMigratedDb(): Promise<PGlite> {
	const db = new PGlite();

	// Load migration SQL directly from filesystem. fileURLToPath() (not
	// .pathname) is required because Vite rewrites import.meta.url to a
	// virtual `/@fs/...` URL whose .pathname doesn't match the on-disk path.
	// Even fileURLToPath rejects that virtual URL, so when the test harness is
	// running under vitest with a vite-rewritten URL we fall back to the env
	// override the harness sets.
	let currentDir: string;
	try {
		currentDir = fileURLToPath(new URL('.', import.meta.url));
	} catch {
		const override = process.env.HEZO_MIGRATIONS_DIR;
		if (!override) {
			throw new Error(
				'createTestDbWithMigrations: import.meta.url is not a file:// URL and HEZO_MIGRATIONS_DIR is unset. ' +
					'Set it to the absolute path of packages/server/migrations.',
			);
		}
		currentDir = '';
	}
	const migrationsDir = process.env.HEZO_MIGRATIONS_DIR
		? process.env.HEZO_MIGRATIONS_DIR
		: join(currentDir, '..', '..', 'migrations');

	// Merge SQL files with code migrations into one ordered set, then apply through
	// the real runMigrations so SQL + code steps run in the same sorted sequence
	// (code migrations like 013 add columns SQL alone won't) with proper tracking.
	const migrations: Record<string, Migration> = {};
	try {
		for (const file of readdirSync(migrationsDir)
			.filter((f: string) => f.endsWith('.sql'))
			.sort()) {
			// PGlite loads pgcrypto built-in; strip only that.
			migrations[file] = readFileSync(join(migrationsDir, file), 'utf-8').replace(
				/CREATE EXTENSION IF NOT EXISTS "pgcrypto";/g,
				'',
			);
		}
	} catch (e) {
		console.error('Migration loading failed:', e);
		throw e;
	}
	Object.assign(migrations, codeMigrations);

	await runMigrations(db, migrations);
	return db;
}

// The post-migration schema is deterministic and identical for every test, but
// replaying all migrations on a fresh PGlite is the single dominant per-test
// cost (~1s: booting the WASM engine runs Postgres `initdb`, then 13 migrations
// apply ~1.5k lines of DDL). Build that schema exactly once per worker process,
// snapshot the datadir, and hand every subsequent test a fresh DB restored from
// the snapshot instead. Restoring a pre-built datadir skips both `initdb` and
// the migration replay, so it lands at ~470ms vs ~1066ms — a >50% cut to the
// setup every one of the ~900 component/backend tests pays in `beforeEach`.
//
// The snapshot is a pristine, data-free schema: each restored DB is fully
// independent (loadDataDir copies the datadir bytes), so seeding, master-key
// init and per-test writes behave exactly as on a freshly-migrated DB. The
// promise is assigned synchronously on the first call so concurrent callers
// share one build rather than racing to migrate in parallel.
let migratedSnapshot: Promise<Blob | File> | null = null;

async function buildSnapshot(): Promise<Blob | File> {
	const template = await buildMigratedDb();
	try {
		// 'none' (uncompressed): the snapshot lives in memory, so avoiding gzip
		// decompression on every restore matters more than its ~30MB footprint.
		return await template.dumpDataDir('none');
	} finally {
		await template.close();
	}
}

/**
 * Creates a test DB with full migrations applied (SQL + code, in one ordered
 * sequence). Backed by a per-process schema snapshot — the first call migrates
 * from scratch and caches the result; every later call restores from that
 * snapshot, which is byte-identical to a fresh migration but ~2x faster.
 */
export async function createTestDbWithMigrations(): Promise<PGlite> {
	if (!migratedSnapshot) migratedSnapshot = buildSnapshot();
	return new PGlite({ loadDataDir: await migratedSnapshot });
}
