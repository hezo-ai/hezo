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
	const { mkdir } = await import('node:fs/promises');
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

	return file;
}

/**
 * Trim the retained set, AFTER the keep-or-discard decision.
 *
 * Pruning as part of writing meant a backup that was then discarded had already
 * cost the oldest one its place: every race left the operator with one fewer,
 * for a file that no longer exists.
 */
async function pruneOldBackups(dir: string): Promise<void> {
	const { readdir, rm } = await import('node:fs/promises');
	const { join } = await import('node:path');
	const existing = (await readdir(dir)).filter((f) => f.endsWith('.backup.gz')).sort();
	for (const excess of existing.slice(
		0,
		Math.max(0, existing.length - KEEP_PRE_MIGRATION_BACKUPS),
	)) {
		await rm(join(dir, excess), { force: true });
	}
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
 * - The downgrade guard runs under that lock, before AND after the run. The lock
 *   is not held across the run, so a newer binary can win it partway through and
 *   migrate past us; the second check is what stops this binary going on to
 *   serve requests against a schema it does not know.
 * - With `backup` set (the startup path), a portable logical backup is written
 *   under the data directory BEFORE anything mutates; a failed backup aborts
 *   the migration entirely (fail-safe). It is written outside the lock, so one
 *   another migrator invalidated mid-write is deleted rather than kept.
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

	// The downgrade guard, run under the lock so it cannot read a database another
	// migrator is halfway through. The winner of a lock race may have been a NEWER
	// binary that migrated past us, and this is where that is caught before
	// anything of ours is applied.
	await assertNotNewerThanApp(db, migrations);

	const pending = await getPendingMigrations(db, migrations);
	if (pending.length === 0) {
		// Not a clean exit. Whoever applied our pending set may have been a NEWER
		// binary that also applied migrations we have never heard of - the ordinary
		// rolling-deploy shape, not a corner - and returning here would boot us
		// against a schema we do not know. Every success path goes through the
		// guard; that is why it is at the bottom rather than after `runMigrations`.
		log.info('Another instance applied the pending migrations first — nothing to do');
	} else {
		await writeBackupAndMigrate(db, migrations, pending, options);
	}

	// And again, now that everything of ours is applied - or that we found there
	// was nothing of ours left to apply.
	//
	// The lock is per transaction, so it is NOT held across the run: a newer
	// binary can win it between our guard above and any point below, migrate the
	// database past us, and leave this binary serving requests against a schema it
	// does not know. Reading rows it cannot interpret, or writing ones that no
	// longer satisfy a constraint added after it, is precisely what the guard
	// exists to prevent - so the answer is to ask once more rather than to reason
	// about why it might be survivable.
	await assertNotNewerThanApp(db, migrations);
}

/** The mutating half, split out so the guard above it has one exit to guard. */
async function writeBackupAndMigrate(
	db: Db,
	migrations: Record<string, Migration>,
	pending: string[],
	options: {
		backup?: ExternalMigrationBackupOptions;
		onProgress?: (detail: string) => void;
	},
): Promise<void> {
	if (options.backup) {
		try {
			options.onProgress?.(
				'Writing a pre-migration backup - this can take a few minutes on a large instance',
			);
			// Deliberately not under the lock: the dump's duration is unbounded, and
			// holding the migration lock across it would block another instance's
			// whole startup. The cost is that another migrator can move underneath
			// it, which `discardIfSuperseded` below is what answers - the dump
			// streams table by table with no snapshot, so a migration landing
			// mid-dump tears it rather than merely dating it.
			const appliedBefore = await appliedMigrationFilenames(db);
			const file = await writePreMigrationBackup(db, migrations, pending, options.backup);
			await discardIfSuperseded(db, appliedBefore, file);
			await pruneOldBackups(options.backup.dir);
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

/**
/**
 * Throw away a pre-migration backup that another migrator made pointless.
 *
 * Not about tearing - `dumpLogicalBackupToFile` reads one REPEATABLE READ
 * snapshot, so a migration committing mid-dump is simply not seen. This is about
 * staleness: a backup insuring migrations that somebody else has already applied
 * insures nothing, and keeping it invites a restore that undoes their work.
 *
 * Compares the full APPLIED set, not our own pending set. A newer binary's
 * migration may carry a filename this binary has never heard of, which leaves
 * our pending set unchanged while the database has moved - and this repo ships
 * duplicate-numbered migrations, so such a filename can sort inside our range
 * rather than after it.
 */
async function discardIfSuperseded(
	db: Db,
	appliedWhenStarted: string[],
	file: string,
): Promise<void> {
	const appliedNow = await appliedMigrationFilenames(db);
	if (appliedNow.join('\u0000') === appliedWhenStarted.join('\u0000')) return;

	const { rm } = await import('node:fs/promises');
	await rm(file, { force: true });
	log.warn(
		`Another instance migrated this database while the pre-migration backup was being ` +
			`written, so it no longer describes the state those migrations would be rolled ` +
			`back to, and has been deleted (${file}). Anything still pending for this ` +
			`instance is applied without one.`,
	);
}

/** Every migration recorded as applied, or none when the table does not exist yet. */
async function appliedMigrationFilenames(db: Db): Promise<string[]> {
	try {
		const result = await db.query<{ filename: string }>(
			'SELECT filename FROM _migrations ORDER BY filename',
		);
		return result.rows.map((r) => r.filename);
	} catch {
		return [];
	}
}

/**
 * Refuse to continue if the database carries migrations this binary does not
 * know - i.e. a newer Hezo has been here.
 *
 * Under the lock, because an unlocked read can catch another migrator mid-run
 * and see a half-applied set that is neither the old state nor the new one.
 */
async function assertNotNewerThanApp(db: Db, migrations: Record<string, Migration>): Promise<void> {
	await db.transaction(async (tx) => {
		await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
		const unknown = await findUnknownAppliedMigrations(tx, migrations);
		if (unknown.length > 0) throw new DbNewerThanAppError(unknown);
	});
}
