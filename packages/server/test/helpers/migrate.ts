import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createMemoryDb } from '../../src/db/client';
import { type Migration, runMigrations } from '../../src/db/migrate';
import { codeMigrations } from '../../src/db/migrations/code';

/**
 * Absolute path to `packages/server/migrations`. `fileURLToPath` (not `.pathname`)
 * is required because Vite rewrites `import.meta.url` to a virtual URL under vitest;
 * when even that rejects, fall back to the `HEZO_MIGRATIONS_DIR` the test runner sets.
 */
export function migrationsDir(): string {
	try {
		return fileURLToPath(new URL('../../migrations', import.meta.url));
	} catch {
		const override = process.env.HEZO_MIGRATIONS_DIR;
		if (!override) {
			throw new Error(
				'migrationsDir: import.meta.url is not a file:// URL and HEZO_MIGRATIONS_DIR is unset. ' +
					'Set it to the absolute path of packages/server/migrations.',
			);
		}
		return override;
	}
}

/** Read a migration SQL file, stripping the pgcrypto extension PGlite loads built-in. */
export function loadMigrationSql(file: string): string {
	return readFileSync(join(migrationsDir(), file), 'utf-8').replace(
		/CREATE EXTENSION IF NOT EXISTS "pgcrypto";/g,
		'',
	);
}

/** Every bundled migration (SQL + code), merged and sorted exactly as the runner sees them. */
function allMigrations(): Record<string, Migration> {
	const migrations: Record<string, Migration> = {};
	for (const file of readdirSync(migrationsDir())
		.filter((f) => f.endsWith('.sql'))
		.sort()) {
		migrations[file] = loadMigrationSql(file);
	}
	return { ...migrations, ...codeMigrations };
}

export interface DataPreservationHarness {
	db: PGlite;
	/** Apply every bundled migration sorted strictly *before* `target` (the prior schema). */
	applyUpToExclusive(target: string): Promise<void>;
	/** Apply `target`; the runner skips the already-applied earlier migrations. */
	applyTarget(target: string): Promise<void>;
	close(): Promise<void>;
}

/**
 * Harness for the rule "every new migration ships a data-preservation test". Boots a
 * fresh in-memory DB so a test can seed representative rows at the schema *before*
 * `target`, then applies `target` through the REAL `runMigrations` — so BEGIN/COMMIT,
 * sorted ordering and checksum tracking match production exactly.
 *
 * Convention: `applyUpToExclusive(target)` → seed → `applyTarget(target)` → assert
 * BOTH that pre-existing data is preserved AND that the migration's change took effect.
 */
export async function createDataPreservationHarness(): Promise<DataPreservationHarness> {
	const db = await createMemoryDb();
	const all = allMigrations();
	const keys = Object.keys(all).sort();

	const subset = (predicate: (key: string) => boolean): Record<string, Migration> => {
		const out: Record<string, Migration> = {};
		for (const key of keys) {
			if (predicate(key)) out[key] = all[key];
		}
		return out;
	};

	return {
		db,
		applyUpToExclusive: (target) =>
			runMigrations(
				db,
				subset((k) => k < target),
			),
		applyTarget: (target) =>
			runMigrations(
				db,
				subset((k) => k <= target),
			),
		close: () => db.close(),
	};
}
