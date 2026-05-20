import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { logger } from '../logger';

const log = logger.child('db');

/** WASM init failures that usually mean pgdata was left half-written or locked. */
export function isRecoverablePgInitError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return (
		msg.includes('Unreachable code should not be executed') ||
		msg.includes('_pg_initdb') ||
		msg.includes('initdb') ||
		msg.includes('could not open file') ||
		msg.includes('invalid record length')
	);
}

export interface OpenPersistentDbOptions {
	reset?: boolean;
}

/**
 * Open (or create) the on-disk PGlite database under `<dataDir>/pgdata`.
 * Retries once after wiping pgdata when init fails due to a corrupt/partial
 * data directory — common when `bun --watch` reloads before the prior
 * instance calls `db.close()`.
 */
export async function openPersistentDb(
	dataDir: string,
	options: OpenPersistentDbOptions = {},
): Promise<PGlite> {
	const pgDataPath = join(dataDir, 'pgdata');

	if (options.reset) {
		rmSync(pgDataPath, { recursive: true, force: true });
	}

	mkdirSync(dataDir, { recursive: true });

	const { NodeFS } = await import('@electric-sql/pglite/nodefs');

	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const db = new PGlite({ fs: new NodeFS(pgDataPath), extensions: { vector } });
			await db.query('SELECT 1');
			return db;
		} catch (err) {
			if (attempt === 0 && isRecoverablePgInitError(err)) {
				log.warn('PGlite init failed; wiping pgdata and retrying', {
					pgDataPath,
					error: err instanceof Error ? err.message : String(err),
				});
				rmSync(pgDataPath, { recursive: true, force: true });
				continue;
			}
			throw err;
		}
	}

	throw new Error('openPersistentDb: retry loop exhausted');
}

/** @deprecated Use {@link openPersistentDb} — kept for callers that only need a bare instance. */
export async function createDb(dataDir: string): Promise<PGlite> {
	return openPersistentDb(dataDir);
}

export async function createMemoryDb(): Promise<PGlite> {
	return new PGlite({ extensions: { vector } });
}
