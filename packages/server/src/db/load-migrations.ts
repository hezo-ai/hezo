import { join } from 'node:path';
import { loadBundledMigrations, loadFilesystemMigrations, type Migration } from './migrate';
import { codeMigrations } from './migrations/code';

/**
 * The binary's full migration set: bundled SQL (compiled binary) or the
 * source tree's `migrations/` (dev, `HEZO_MIGRATIONS_DIR` for tests), merged
 * with the code migrations into the one sorted sequence the runner applies.
 * Shared by startup and the backup/restore CLI. Returns null when no
 * migrations can be found at all.
 */
export async function loadAllMigrations(): Promise<Record<string, Migration> | null> {
	let sql: Record<string, string> | null = null;
	try {
		sql = await loadBundledMigrations();
	} catch {
		try {
			const migrationsDir =
				process.env.HEZO_MIGRATIONS_DIR ??
				join(new URL('.', import.meta.url).pathname, '..', '..', 'migrations');
			sql = await loadFilesystemMigrations(migrationsDir);
		} catch {
			sql = null;
		}
	}
	if (!sql) return null;
	return { ...sql, ...codeMigrations };
}
