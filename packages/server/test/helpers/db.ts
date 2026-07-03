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

/** Creates a test DB with full migrations applied (SQL + code, in one ordered sequence). */
export async function createTestDbWithMigrations(): Promise<PGlite> {
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
