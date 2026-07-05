import { createHash } from 'node:crypto';
import { logger } from '../logger';
import type { Db, Queryable } from './database';

const log = logger.child('migrate');

/**
 * A migration is either a SQL string (the common case) or a code step — a JS
 * function that reshapes data in ways SQL can't express (parse/re-encode/
 * re-encrypt with app-side logic). Both run inside the same per-migration
 * transaction, so a throw rolls the whole step back. A code step must NOT
 * issue its own BEGIN/COMMIT — the runner owns the transaction.
 */
export type CodeMigration = {
	run: (db: Queryable) => Promise<void>;
	/**
	 * Stable identity for change-detection. Prefer setting this explicitly (a
	 * minifier rewriting `run.toString()` would otherwise shift the checksum and
	 * log a spurious "changed since applied" warning — never a re-apply).
	 */
	checksum?: string;
};

export type Migration = string | CodeMigration;

function isCodeMigration(m: Migration): m is CodeMigration {
	return typeof m !== 'string';
}

function checksumOf(m: Migration): string {
	if (isCodeMigration(m)) {
		return m.checksum ?? createHash('sha256').update(m.run.toString()).digest('hex');
	}
	return createHash('sha256').update(m).digest('hex');
}

export async function runMigrations(db: Db, migrations: Record<string, Migration>): Promise<void> {
	await db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id          SERIAL PRIMARY KEY,
      filename    TEXT NOT NULL UNIQUE,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      checksum    TEXT NOT NULL
    );
  `);

	const applied = await db.query<{ filename: string; checksum: string }>(
		'SELECT filename, checksum FROM _migrations ORDER BY id',
	);
	const appliedMap = new Map(applied.rows.map((r) => [r.filename, r.checksum]));

	const filenames = Object.keys(migrations).sort();

	for (const filename of filenames) {
		const migration = migrations[filename];
		const checksum = checksumOf(migration);

		if (appliedMap.has(filename)) {
			if (appliedMap.get(filename) !== checksum) {
				log.warn(`Migration ${filename} has changed since it was applied`);
			}
			continue;
		}

		try {
			await db.transaction(async (tx) => {
				if (isCodeMigration(migration)) {
					await migration.run(tx);
				} else {
					await tx.exec(migration);
				}
				await tx.query('INSERT INTO _migrations (filename, checksum) VALUES ($1, $2)', [
					filename,
					checksum,
				]);
			});
			log.info(`Applied migration: ${filename}`);
		} catch (err) {
			throw new Error(`Migration ${filename} failed: ${err}`);
		}
	}
}

/**
 * Applied migrations recorded in `_migrations` that the running binary does not
 * know about — i.e. the data dir was migrated by a *newer* Hezo version. Relies
 * on the append-only, stable-filename policy (released migrations are never
 * renamed or removed), so an unknown applied filename can only mean "from the
 * future". Returns `[]` when `_migrations` doesn't exist yet (brand-new DB).
 */
export async function findUnknownAppliedMigrations(
	db: Queryable,
	migrations: Record<string, Migration>,
): Promise<string[]> {
	let appliedRows: { filename: string }[];
	try {
		const res = await db.query<{ filename: string }>('SELECT filename FROM _migrations');
		appliedRows = res.rows;
	} catch {
		return [];
	}
	const known = new Set(Object.keys(migrations));
	return appliedRows
		.map((r) => r.filename)
		.filter((f) => !known.has(f))
		.sort();
}

/** Bundled migration filenames (sorted) not yet recorded in `_migrations`. */
export async function getPendingMigrations(
	db: Queryable,
	migrations: Record<string, Migration>,
): Promise<string[]> {
	let appliedSet = new Set<string>();
	try {
		const applied = await db.query<{ filename: string }>('SELECT filename FROM _migrations');
		appliedSet = new Set(applied.rows.map((r) => r.filename));
	} catch {
		// `_migrations` doesn't exist yet → a brand-new DB, everything is pending.
	}
	return Object.keys(migrations)
		.sort()
		.filter((f) => !appliedSet.has(f));
}

export async function loadBundledMigrations(): Promise<Record<string, string>> {
	// A *literal* dynamic import is statically analyzable, so `bun build --compile`
	// embeds the JSON into the binary's virtual FS. A runtime `readFile` of a
	// sibling path is NOT embedded (it resolves to `/$bunfs/root/...` and ENOENTs).
	// In dev (`bun run`) the file may be absent — the import rejects and the caller
	// falls back to `loadFilesystemMigrations`.
	let mod: { default: Record<string, string> };
	try {
		mod = (await import('./migrations-bundle.json')) as { default: Record<string, string> };
	} catch {
		throw new Error("Failed to load migration bundle. Run 'bun run build:migrations' first.");
	}
	// An empty stub (written by `scripts/ensure-bundles.ts` so tsc/vite can
	// resolve the literal import) means the bundle was never generated — treat it
	// as absent so the caller falls back to the filesystem.
	if (Object.keys(mod.default).length === 0) {
		throw new Error('Migration bundle is empty. Run "bun run build:migrations" first.');
	}
	return mod.default;
}

export async function loadFilesystemMigrations(
	migrationsDir: string,
): Promise<Record<string, string>> {
	const { readdir, readFile } = await import('node:fs/promises');
	const { join } = await import('node:path');
	const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
	const migrations: Record<string, string> = {};
	await Promise.all(
		files.map(async (file) => {
			migrations[file] = await readFile(join(migrationsDir, file), 'utf-8');
		}),
	);
	return migrations;
}
