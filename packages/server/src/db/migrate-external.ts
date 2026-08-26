import { logger } from '../logger';
import type { Db } from './database';
import {
	findUnknownAppliedMigrations,
	getPendingMigrations,
	MIGRATION_LOCK_KEY,
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
	const { mkdir, readdir, rm } = await import('node:fs/promises');
	const { join } = await import('node:path');
	const { dumpLogicalBackupToFile } = await import('./logical-backup.js');

	await mkdir(backup.dir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const file = join(backup.dir, `hezo-${stamp}-pre-${backup.version}.backup.gz`);
	// Streamed to disk, never buffered: this runs on the startup path, so an
	// out-of-memory kill here takes the whole instance into a restart loop that
	// repeats the same kill on every boot.
	await dumpLogicalBackupToFile(db, file, { hezoVersion: backup.version, migrations });
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
 * - A transaction-scoped `pg_advisory_xact_lock` serializes concurrent Hezo
 *   instances, taken inside each migration's own transaction; it is released by
 *   the commit or rollback, so a crashed migrator never wedges others, and it
 *   needs no connection of its own.
 * - The downgrade guard re-runs under that lock — the winner of the lock race
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
	options: {
		backup?: ExternalMigrationBackupOptions;
		/** Display-safe step line, forwarded to the boot-phase detail. See `migrate-runner.ts`. */
		onProgress?: (detail: string) => void;
	} = {},
): Promise<void> {
	// Cheap pre-check — the common nothing-pending boot path.
	const unknownEarly = await findUnknownAppliedMigrations(db, migrations);
	if (unknownEarly.length > 0) throw new DbNewerThanAppError(unknownEarly);
	if ((await getPendingMigrations(db, migrations)).length === 0) return;

	// The downgrade guard, re-run under the lock. The winner of a lock race may
	// have been a NEWER binary that migrated past us, and this is where that is
	// caught before anything of ours is applied.
	//
	// The lock is released when this transaction commits rather than held across
	// the run, so a newer binary could still win between here and the first
	// migration below. That cannot corrupt anything: each migration re-checks
	// under its own lock and applies at most once, and the append-only policy
	// means an older binary's migration is never one a newer database has
	// superseded. Worst case the boot is refused on the next start instead of
	// this one.
	await db.transaction(async (tx) => {
		await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
		const unknown = await findUnknownAppliedMigrations(tx, migrations);
		if (unknown.length > 0) throw new DbNewerThanAppError(unknown);
	});

	const pending = await getPendingMigrations(db, migrations);
	if (pending.length === 0) {
		log.info('Another instance applied the pending migrations first — nothing to do');
		return;
	}

	if (options.backup) {
		try {
			options.onProgress?.(
				'Writing a pre-migration backup - this can take a few minutes on a large instance',
			);
			// Not under a lock: two instances starting together may each write one,
			// which costs time and disk but cannot corrupt anything. Holding a lock
			// across a backup that takes minutes is the worse trade - it is the one
			// step here whose duration is unbounded.
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
		await runMigrations(db, migrations, {
			onProgress: ({ filename, index, total }) =>
				options.onProgress?.(`Applying ${filename} (${index} of ${total})`),
		});
	} catch (err) {
		throw new ExternalMigrationFailedError(pending, err);
	}
}
