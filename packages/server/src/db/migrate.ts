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

/** Public checksum accessor (logical-backup compares recorded vs local sets). */
export function checksumOfMigration(m: Migration): string {
	return checksumOf(m);
}

/**
 * Advisory lock key serializing concurrent migrators. "HEZO".
 *
 * Taken **per transaction**, not per session. A session-scoped lock has to be
 * held on a dedicated connection - it belongs to the session, not to the
 * statement - which meant a second connection existed for no other purpose, and
 * a pool of one deadlocked the migration path. A transaction-scoped lock lives
 * and dies inside the transaction that already has a connection, so it needs no
 * second one, and it survives a transaction-mode connection pooler, which does
 * not keep a caller on one backend between statements.
 */
export const MIGRATION_LOCK_KEY = 0x48455a4f;
// Arbitrary, but it MUST stay fixed forever: changing it lets an old binary and
// a new one migrate the same database concurrently, each holding a lock the
// other does not contend for.

/** Progress for one step of a `runMigrations` pass. */
export interface MigrationProgress {
	/** The migration about to be applied. */
	filename: string;
	/** 1-based position within THIS run's pending set. */
	index: number;
	/** How many migrations this run will apply. */
	total: number;
}

export interface RunMigrationsOptions {
	/**
	 * Called just before each pending migration is applied. Startup wires this to
	 * the boot-phase detail so the loading screen names the migration in flight -
	 * a long migration is otherwise indistinguishable from a hung server.
	 */
	onProgress?: (progress: MigrationProgress) => void;
}

export async function runMigrations(
	db: Db,
	migrations: Record<string, Migration>,
	options: RunMigrationsOptions = {},
): Promise<void> {
	// Under the lock, because `CREATE TABLE IF NOT EXISTS` is NOT atomic against a
	// concurrent create: two instances booting together against a brand-new
	// database race inside the catalog and one dies with a duplicate-key error on
	// `pg_class`. It used to sit inside the session lock by inheritance, since the
	// caller held one for the whole run; a per-transaction lock has to take it
	// here explicitly.
	await db.transaction(async (tx) => {
		await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
		await tx.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id          SERIAL PRIMARY KEY,
        filename    TEXT NOT NULL UNIQUE,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        checksum    TEXT NOT NULL
      );
    `);
	});

	const applied = await db.query<{ filename: string; checksum: string }>(
		'SELECT filename, checksum FROM _migrations ORDER BY id',
	);
	const appliedMap = new Map(applied.rows.map((r) => [r.filename, r.checksum]));

	const filenames = Object.keys(migrations).sort();
	const total = filenames.filter((f) => !appliedMap.has(f)).length;
	let index = 0;

	for (const filename of filenames) {
		const migration = migrations[filename];
		const checksum = checksumOf(migration);

		if (appliedMap.has(filename)) {
			if (appliedMap.get(filename) !== checksum) {
				log.warn(`Migration ${filename} has changed since it was applied`);
			}
			continue;
		}

		index += 1;
		options.onProgress?.({ filename, index, total });

		let skipped = false;
		try {
			await db.transaction(async (tx) => {
				// Serializes concurrent migrators, and is released by the commit or
				// rollback either way - a migrator that dies mid-step never wedges
				// the next one.
				await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);

				// Re-read under the lock. The applied set was read before the loop,
				// and whoever we just queued behind may have applied this very
				// migration while we waited.
				//
				// This read is the fast path, not the guarantee. At REPEATABLE READ
				// the snapshot is taken BY the lock statement - before it blocks - so
				// the re-read can still miss a commit that landed while we waited, and
				// the body would run again. What makes "applied at most once" true
				// regardless is the UNIQUE constraint on `_migrations.filename`: the
				// second INSERT fails and the whole transaction rolls back, taking the
				// re-run body with it. Say so here rather than leave the property
				// resting on a default isolation level a provider can change.
				const already = await tx.query('SELECT 1 FROM _migrations WHERE filename = $1', [filename]);
				if (already.rows.length > 0) {
					log.info(`Migration ${filename} was applied by another instance; skipping`);
					skipped = true;
					return;
				}

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
			if (!skipped) log.info(`Applied migration: ${filename}`);
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
