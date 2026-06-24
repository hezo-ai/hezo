import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { BASE_SCHEMA } from '../../src/db/schema';

/** Creates a fresh in-memory PGlite instance with base tables for testing. */
export async function createTestDb(): Promise<PGlite> {
	const db = new PGlite();
	await db.exec(BASE_SCHEMA);
	return db;
}

/** Creates a test DB with full migrations applied. */
export async function createTestDbWithMigrations(): Promise<PGlite> {
	const db = new PGlite();

	// Ensure _migrations table exists (uses IF NOT EXISTS, safe to run before migration)
	await db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id          SERIAL PRIMARY KEY,
      filename    TEXT NOT NULL UNIQUE,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      checksum    TEXT NOT NULL
    );
  `);

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

	try {
		const files = readdirSync(migrationsDir)
			.filter((f: string) => f.endsWith('.sql'))
			.sort();

		for (const file of files) {
			let sql = readFileSync(join(migrationsDir, file), 'utf-8');
			// PGlite loads pgcrypto built-in; strip only that.
			sql = sql.replace(/CREATE EXTENSION IF NOT EXISTS "pgcrypto";/g, '');
			try {
				await db.exec(sql);
			} catch (e) {
				console.error(`Migration ${file} failed:`, e);
				throw e;
			}
		}
	} catch (e) {
		console.error('Migration loading failed:', e);
		throw e;
	}

	return db;
}
