import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { BASE_SCHEMA } from '../../db/schema';

/** Creates a fresh in-memory PGlite instance with base tables for testing. */
export async function createTestDb(): Promise<PGlite> {
	const db = new PGlite({ extensions: { vector } });
	await db.exec(BASE_SCHEMA);
	return db;
}

/** Creates a test DB with full migrations applied. */
export async function createTestDbWithMigrations(): Promise<PGlite> {
	const db = new PGlite({ extensions: { vector } });

	// Ensure _migrations table exists (uses IF NOT EXISTS, safe to run before migration)
	await db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id          SERIAL PRIMARY KEY,
      filename    TEXT NOT NULL UNIQUE,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      checksum    TEXT NOT NULL
    );
  `);

	// Load migration SQL directly from filesystem
	const currentDir = new URL('.', import.meta.url).pathname;
	const migrationsDir = join(currentDir, '..', '..', '..', 'migrations');

	try {
		const files = readdirSync(migrationsDir)
			.filter((f: string) => f.endsWith('.sql'))
			.sort();

		for (const file of files) {
			let sql = readFileSync(join(migrationsDir, file), 'utf-8');
			// PGlite loads pgcrypto built-in, strip only that; keep vector (loaded via config + SQL)
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
