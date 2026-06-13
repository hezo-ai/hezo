import type { PGlite } from '@electric-sql/pglite';
import { logger } from '../logger';
import { openPersistentDb } from './client';
import {
	findUnknownAppliedMigrations,
	getPendingMigrations,
	type Migration,
	runMigrations,
} from './migrate';
import { DbNewerThanAppError, MigrationFailedError } from './migrate-errors';
import { discardMigrationCopy, prepareMigrationCopy, promoteMigrationCopy } from './migrate-swap';
import { BASE_SCHEMA } from './schema';

const log = logger.child('migrate-runner');

async function countApplied(db: PGlite): Promise<number> {
	try {
		const r = await db.query<{ c: number }>('SELECT COUNT(*)::int AS c FROM _migrations');
		return r.rows[0]?.c ?? 0;
	} catch {
		return 0;
	}
}

/**
 * Apply any pending migrations safely, returning the live DB handle to keep
 * using (which may be a NEW handle — see below). The data dir's `pgdata` is the
 * source of truth.
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
export async function applyPendingMigrations(
	db: PGlite,
	dataDir: string,
	migrations: Record<string, Migration>,
): Promise<PGlite> {
	const unknown = await findUnknownAppliedMigrations(db, migrations);
	if (unknown.length > 0) {
		throw new DbNewerThanAppError(unknown);
	}

	const pending = await getPendingMigrations(db, migrations);
	if (pending.length === 0) return db;

	if ((await countApplied(db)) === 0) {
		// Brand-new DB: nothing to lose, migrate in place.
		await runMigrations(db, migrations);
		return db;
	}

	// Existing instance: migrate a copy, swap on success, preserve original on failure.
	log.info(`Applying ${pending.length} migration(s) to a temporary copy: ${pending.join(', ')}`);
	await db.close();

	const tmpDataDir = await prepareMigrationCopy(dataDir);
	const tempDb = await openPersistentDb(tmpDataDir);
	try {
		await tempDb.exec(BASE_SCHEMA);
		await runMigrations(tempDb, migrations);
	} catch (err) {
		await tempDb.close().catch(() => undefined);
		await discardMigrationCopy(dataDir);
		throw new MigrationFailedError(pending, dataDir, err);
	}
	await tempDb.close();
	await promoteMigrationCopy(dataDir);
	return openPersistentDb(dataDir);
}
