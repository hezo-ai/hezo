import { createHash } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { logger } from '../logger';

const log = logger.child('migrate');

export async function runMigrations(db: PGlite, migrations: Record<string, string>): Promise<void> {
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
		const sql = migrations[filename];
		const checksum = createHash('sha256').update(sql).digest('hex');

		if (appliedMap.has(filename)) {
			if (appliedMap.get(filename) !== checksum) {
				log.warn(`Migration ${filename} has changed since it was applied`);
			}
			continue;
		}

		await db.exec('BEGIN');
		try {
			await db.exec(sql);
			await db.query('INSERT INTO _migrations (filename, checksum) VALUES ($1, $2)', [
				filename,
				checksum,
			]);
			await db.exec('COMMIT');
			log.info(`Applied migration: ${filename}`);
		} catch (err) {
			await db.exec('ROLLBACK');
			throw new Error(`Migration ${filename} failed: ${err}`);
		}
	}
}

/** Bundled migration filenames (sorted) not yet recorded in `_migrations`. */
export async function getPendingMigrations(
	db: PGlite,
	migrations: Record<string, string>,
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
