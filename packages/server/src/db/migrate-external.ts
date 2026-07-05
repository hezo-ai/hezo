import { logger } from '../logger';
import type { Db } from './database';
import {
	findUnknownAppliedMigrations,
	getPendingMigrations,
	type Migration,
	runMigrations,
} from './migrate';
import {
	DbNewerThanAppError,
	ExternalDbError,
	ExternalMigrationFailedError,
} from './migrate-errors';

const log = logger.child('migrate-external');

/**
 * Advisory-lock key that serializes migrations across Hezo instances sharing
 * one external database. Arbitrary, but it MUST stay fixed forever — changing
 * it would let an old and a new binary migrate concurrently.
 */
export const MIGRATION_LOCK_KEY = 0x48455a4f; // "HEZO"

export interface ExternalMigrationBackupOptions {
	/** Directory for the pre-migration logical backup (usually `<dataDir>/backups`). */
	dir: string;
	/** Hezo version stamped into the backup filename and header. */
	version: string;
}

/** How many pre-migration logical backups to retain (matches the embedded convention). */
const KEEP_PRE_MIGRATION_BACKUPS = 5;

async function writePreMigrationBackup(
	db: Db,
	migrations: Record<string, Migration>,
	pending: string[],
	backup: ExternalMigrationBackupOptions,
): Promise<string> {
	const { mkdir, readdir, rm, writeFile } = await import('node:fs/promises');
	const { join } = await import('node:path');
	const { dumpLogicalBackup } = await import('./logical-backup.js');

	const bytes = await dumpLogicalBackup(db, { hezoVersion: backup.version, migrations });
	await mkdir(backup.dir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const file = join(backup.dir, `hezo-${stamp}-pre-${backup.version}.backup.gz`);
	await writeFile(file, bytes);
	log.info(`Wrote pre-migration logical backup (${pending.length} pending) → ${file}`);

	const existing = (await readdir(backup.dir)).filter((f) => f.endsWith('.backup.gz')).sort();
	for (const excess of existing.slice(
		0,
		Math.max(0, existing.length - KEEP_PRE_MIGRATION_BACKUPS),
	)) {
		await rm(join(backup.dir, excess), { force: true });
	}
	return file;
}

/**
 * Apply pending migrations IN PLACE to an external Postgres. The embedded
 * copy-migrate-swap has no analogue here (there is no directory to copy), so
 * the safety model is different:
 *
 * - A session-scoped `pg_advisory_lock` serializes concurrent Hezo instances;
 *   the lock dies with the session, so a crashed migrator never wedges others.
 * - The downgrade guard re-runs UNDER the lock — the winner of the lock race
 *   may have been a newer binary that migrated past us.
 * - With `backup` set (the startup path), a portable logical backup is written
 *   under the data directory BEFORE anything mutates; a failed backup aborts
 *   the migration entirely (fail-safe).
 * - Each migration commits its own transaction (`runMigrations`), so a failure
 *   leaves the already-applied prefix durable; a re-run after fixing the cause
 *   resumes from the failed migration. The append-only/frozen migration policy
 *   makes that partially-advanced state safe.
 */
export async function applyPendingMigrationsExternal(
	db: Db,
	migrations: Record<string, Migration>,
	options: { backup?: ExternalMigrationBackupOptions } = {},
): Promise<void> {
	// Cheap pre-check outside the lock — the common nothing-pending boot path.
	const unknownEarly = await findUnknownAppliedMigrations(db, migrations);
	if (unknownEarly.length > 0) throw new DbNewerThanAppError(unknownEarly);
	if ((await getPendingMigrations(db, migrations)).length === 0) return;

	log.info('Acquiring the migration lock (waits if another Hezo instance is migrating)…');
	const lock = await db.acquireSessionLock(MIGRATION_LOCK_KEY);
	try {
		const unknown = await findUnknownAppliedMigrations(db, migrations);
		if (unknown.length > 0) throw new DbNewerThanAppError(unknown);

		const pending = await getPendingMigrations(db, migrations);
		if (pending.length === 0) {
			log.info('Another instance applied the pending migrations first — nothing to do');
			return;
		}

		if (options.backup) {
			try {
				await writePreMigrationBackup(db, migrations, pending, options.backup);
			} catch (err) {
				throw new ExternalDbError(
					`Could not write the pre-migration backup under ${options.backup.dir}; ` +
						`aborting the migration so the database is left untouched. Fix the cause ` +
						`(disk space/permissions) and start Hezo again. (cause: ${
							err instanceof Error ? err.message : String(err)
						})`,
					err,
				);
			}
		}

		log.info(`Applying ${pending.length} migration(s) in place: ${pending.join(', ')}`);
		try {
			await runMigrations(db, migrations);
		} catch (err) {
			throw new ExternalMigrationFailedError(pending, err);
		}
	} finally {
		await lock.release();
	}
}
