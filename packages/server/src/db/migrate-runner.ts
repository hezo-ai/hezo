import { logger } from '../logger';
import { openPersistentDb } from './client';
import type { Db, Queryable } from './database';
import { PgliteDb } from './drivers/pglite';
import {
	findUnknownAppliedMigrations,
	getPendingMigrations,
	type Migration,
	type MigrationProgress,
	runMigrations,
} from './migrate';
import { DbNewerThanAppError, MigrationFailedError } from './migrate-errors';
import { discardMigrationCopy, prepareMigrationCopy, promoteMigrationCopy } from './migrate-swap';
import { BASE_SCHEMA } from './schema';

const log = logger.child('migrate-runner');

async function countApplied(db: Queryable): Promise<number> {
	try {
		const r = await db.query<{ c: number }>('SELECT COUNT(*)::int AS c FROM _migrations');
		return r.rows[0]?.c ?? 0;
	} catch {
		return 0;
	}
}

/**
 * Apply any pending migrations safely to the EMBEDDED database, returning the
 * live handle to keep using (which may be a NEW handle — see below). The data
 * dir's `pgdata` is the source of truth. External Postgres migrates in place
 * instead — see `migrate-external.ts`.
 *
 * Behavior:
 * - **Newer-than-binary DB** → throws `DbNewerThanAppError` (the data dir has
 *   migrations this build doesn't know about). The DB is not touched.
 * - **Nothing pending** → returns the same `db`.
 * - **Fresh install** (nothing applied yet) → migrates in place; there's no user
 *   data to protect, so no copy.
 * - **Existing instance with pending** → copy-migrate-swap: the live DB is
 *   closed, `pgdata` is copied aside, migrations run against the COPY, and only
 *   on full success is the copy atomically swapped in (and a fresh handle
 *   returned). On failure the original `pgdata` is left exactly as it was and
 *   `MigrationFailedError` is thrown — a downgraded binary can run against it
 *   unchanged.
 */
export interface ApplyPendingMigrationsOptions {
	/**
	 * Called with a short, display-safe line each time the run moves to a new
	 * step. Startup forwards it to the boot-phase detail: the copy of `pgdata`
	 * dominates the wall clock on a large instance, so without it the loading
	 * screen sits on "Running database migrations…" for minutes with no sign of
	 * life. Never carries a path or a secret.
	 */
	onProgress?: (detail: string) => void;
}

export async function applyPendingMigrations(
	db: Db,
	dataDir: string,
	migrations: Record<string, Migration>,
	options: ApplyPendingMigrationsOptions = {},
): Promise<Db> {
	const unknown = await findUnknownAppliedMigrations(db, migrations);
	if (unknown.length > 0) {
		throw new DbNewerThanAppError(unknown);
	}

	const pending = await getPendingMigrations(db, migrations);
	if (pending.length === 0) return db;

	const report = (detail: string) => options.onProgress?.(detail);
	const applying = ({ filename, index, total }: MigrationProgress) =>
		report(`Applying ${filename} (${index} of ${total})`);

	if ((await countApplied(db)) === 0) {
		// Brand-new DB: nothing to lose, migrate in place.
		await runMigrations(db, migrations, { onProgress: applying });
		return db;
	}

	// Existing instance: migrate a copy, swap on success, preserve original on failure.
	log.info(`Applying ${pending.length} migration(s) to a temporary copy: ${pending.join(', ')}`);
	await db.close();

	// The copy is proportional to the size of the database, so on a busy instance
	// it can run for minutes before the first migration even starts. Say so.
	report('Copying the database aside first - this can take a few minutes on a large instance');
	const tmpDataDir = await prepareMigrationCopy(dataDir);
	const tempDb = new PgliteDb(await openPersistentDb(tmpDataDir));
	try {
		await tempDb.exec(BASE_SCHEMA);
		await runMigrations(tempDb, migrations, { onProgress: applying });
	} catch (err) {
		await tempDb.close().catch(() => undefined);
		await discardMigrationCopy(dataDir);
		throw new MigrationFailedError(pending, dataDir, err);
	}
	await tempDb.close();
	report('Swapping in the migrated database');
	await promoteMigrationCopy(dataDir);
	return new PgliteDb(await openPersistentDb(dataDir));
}
