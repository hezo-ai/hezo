import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { logger } from '../logger';
import { PgliteDb } from './drivers/pglite';

const log = logger.child('db');

/** WASM init failures that usually mean pgdata was left half-written or locked. */
export function isRecoverablePgInitError(err: unknown): boolean {
	if (err instanceof WebAssembly.RuntimeError) return true;
	const msg = err instanceof Error ? err.message : String(err);
	return (
		msg.includes('Unreachable code should not be executed') ||
		msg.includes('_pg_initdb') ||
		msg.includes('initdb') ||
		msg.includes('could not open file') ||
		msg.includes('invalid record length') ||
		msg.includes('Aborted()') ||
		msg.includes('Build with -sASSERTIONS')
	);
}

export class PgDataCorruptError extends Error {
	constructor(
		message: string,
		readonly pgDataPath: string,
		readonly backupPathHint: string,
		readonly cause: unknown,
	) {
		super(message);
		this.name = 'PgDataCorruptError';
	}
}

export interface OpenPersistentDbOptions {
	reset?: boolean;
}

/**
 * Open (or create) the on-disk PGlite database under `<dataDir>/pgdata`.
 *
 * Behaviour:
 * - Normal open: returns a working PGlite handle.
 * - `options.reset === true`: renames any existing pgdata aside as
 *   `pgdata.corrupt.<timestamp>` (never silently deletes), then creates a
 *   fresh DB. The renamed copy can be inspected later with a standalone
 *   PGlite process.
 * - Init fails with a recoverable WASM/initdb signature: throws
 *   `PgDataCorruptError` with the path where a backup would be saved if
 *   the user re-runs with `--reset`. Callers should surface this to the
 *   user verbatim — recovery is opt-in, never automatic.
 */
export async function openPersistentDb(
	dataDir: string,
	options: OpenPersistentDbOptions = {},
): Promise<PGlite> {
	const pgDataPath = join(dataDir, 'pgdata');

	mkdirSync(dataDir, { recursive: true });

	if (options.reset && existsSync(pgDataPath)) {
		const corruptPath = `${pgDataPath}.corrupt.${Date.now()}`;
		log.warn('Reset requested; renaming existing pgdata aside before creating fresh DB', {
			pgDataPath,
			corruptPath,
		});
		renameSync(pgDataPath, corruptPath);
	}

	const { NodeFS } = await import('@electric-sql/pglite/nodefs');
	const { loadPgliteAssets } = await import('./pglite-assets');

	// In the compiled binary, PGlite's WASM/data assets are embedded and injected
	// from memory; in dev this is null and PGlite resolves them from node_modules.
	const assets = await loadPgliteAssets();

	try {
		const db = assets
			? new PGlite({
					fs: new NodeFS(pgDataPath),
					wasmModule: assets.wasmModule,
					fsBundle: assets.fsBundle,
				})
			: new PGlite({ fs: new NodeFS(pgDataPath) });
		await db.query('SELECT 1');
		return db;
	} catch (err) {
		if (isRecoverablePgInitError(err)) {
			const backupPathHint = `${pgDataPath}.corrupt.<timestamp>`;
			const causeMsg = err instanceof Error ? err.message : String(err);
			const message =
				`Database at ${pgDataPath} appears corrupt (PGlite init failed: ${causeMsg}).\n` +
				`To preserve a backup and start with a fresh database, restart the server ` +
				`with --reset. The existing pgdata will be renamed to ${backupPathHint} before ` +
				`a fresh database is created. No data is deleted.`;
			throw new PgDataCorruptError(message, pgDataPath, backupPathHint, err);
		}
		throw err;
	}
}

/** @deprecated Use {@link openPersistentDb} — kept for callers that only need a bare instance. */
export async function createDb(dataDir: string): Promise<PGlite> {
	return openPersistentDb(dataDir);
}

/** In-memory database wrapped in the `Db` driver — the test-suite workhorse. */
export async function createMemoryDb(): Promise<PgliteDb> {
	return new PgliteDb(new PGlite());
}
