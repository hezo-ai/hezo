import { logger } from '../logger';
import type { Db } from './database';
import {
	findUnknownAppliedMigrations,
	getPendingMigrations,
	type Migration,
	runMigrations,
} from './migrate';
import { DbNewerThanAppError, ExternalMigrationFailedError } from './migrate-errors';

const log = logger.child('migrate-external');

/**
 * Advisory-lock key that serializes migrations across Hezo instances sharing
 * one external database. Arbitrary, but it MUST stay fixed forever — changing
 * it would let an old and a new binary migrate concurrently.
 */
export const MIGRATION_LOCK_KEY = 0x48455a4f; // "HEZO"

/**
 * Apply pending migrations IN PLACE to an external Postgres. The embedded
 * copy-migrate-swap has no analogue here (there is no directory to copy), so
 * the safety model is different:
 *
 * - A session-scoped `pg_advisory_lock` serializes concurrent Hezo instances;
 *   the lock dies with the session, so a crashed migrator never wedges others.
 * - The downgrade guard re-runs UNDER the lock — the winner of the lock race
 *   may have been a newer binary that migrated past us.
 * - Each migration commits its own transaction (`runMigrations`), so a failure
 *   leaves the already-applied prefix durable; a re-run after fixing the cause
 *   resumes from the failed migration. The append-only/frozen migration policy
 *   makes that partially-advanced state safe.
 */
export async function applyPendingMigrationsExternal(
	db: Db,
	migrations: Record<string, Migration>,
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
