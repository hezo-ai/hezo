import { cp, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../logger';
import { pruneSuperseded, SUPERSEDED_PREFIX } from './superseded';

const log = logger.child('migrate-swap');

/** Temp data dir (sibling of `pgdata`) where migrations run against a copy. */
const MIGRATE_TMP = '.migrate-tmp';
/** How many superseded `pgdata` directories the migration swap retains. */
const KEEP_SUPERSEDED = 5;

function pgDataPath(dataDir: string): string {
	return join(dataDir, 'pgdata');
}

function tmpDataDir(dataDir: string): string {
	return join(dataDir, MIGRATE_TMP);
}

/**
 * Copy the live `pgdata` into a temporary sibling data dir so migrations run
 * against the copy, never the original. The live DB MUST be closed first (so
 * its files are flushed and consistent). Returns the temp *data dir* (the path
 * to pass to `openPersistentDb`, which appends `pgdata` itself).
 */
export async function prepareMigrationCopy(dataDir: string): Promise<string> {
	const tmp = tmpDataDir(dataDir);
	await rm(tmp, { recursive: true, force: true });
	await mkdir(tmp, { recursive: true });
	await cp(pgDataPath(dataDir), join(tmp, 'pgdata'), { recursive: true });
	return tmp;
}

/**
 * Atomically swap the migrated copy into place: rename the original `pgdata`
 * aside (kept for recovery / inspection, pruned to the last `KEEP_SUPERSEDED`),
 * move the migrated copy into `pgdata`, and remove the temp dir. All renames are
 * within `dataDir` (same filesystem) so each is atomic.
 */
export async function promoteMigrationCopy(dataDir: string): Promise<void> {
	const tmp = tmpDataDir(dataDir);
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const supersededPath = join(dataDir, `${SUPERSEDED_PREFIX}${stamp}`);

	await rename(pgDataPath(dataDir), supersededPath);
	await rename(join(tmp, 'pgdata'), pgDataPath(dataDir));
	await rm(tmp, { recursive: true, force: true });

	await pruneSuperseded(dataDir, KEEP_SUPERSEDED);
	log.info(`Swapped in migrated database; previous pgdata kept at ${supersededPath}`);
}

/** Remove the temp copy after a failed migration. The original is untouched. */
export async function discardMigrationCopy(dataDir: string): Promise<void> {
	await rm(tmpDataDir(dataDir), { recursive: true, force: true });
}
