import { join } from 'node:path';
import { redactDatabaseUrl, type StorageInfo } from '../lib/db-info';
import { logger } from '../logger';
import { openPersistentDb } from './client';
import type { Db } from './database';
import { PgliteDb } from './drivers/pglite';
import { ExternalDbError } from './migrate-errors';
import { assertExternalPostgresCompatible } from './postgres-preflight';

const log = logger.child('db-open');

export interface OpenDatabaseOptions {
	dataDir: string;
	/** External Postgres connection string; omitted → embedded PGlite under `<dataDir>/pgdata`. */
	databaseUrl?: string;
	/** Embedded-only: rename a corrupt pgdata aside and start fresh. */
	reset?: boolean;
}

export interface OpenedDatabase {
	db: Db;
	/** Pre-redacted metadata for logs and the settings endpoint — safe to expose. */
	storage: StorageInfo;
}

const CONNECT_ATTEMPTS = 3;
const CONNECT_BACKOFF_MS = [2_000, 4_000];

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePoolSize(raw: string | undefined): number | undefined {
	if (!raw) return undefined;
	const n = Number.parseInt(raw, 10);
	if (Number.isNaN(n)) return undefined;
	return Math.min(Math.max(n, 2), 100);
}

/**
 * The single startup entry for the storage layer: embedded PGlite when no URL
 * is configured (the default — zero change for existing installs), external
 * Postgres via `--database-url` / `HEZO_DATABASE_URL` otherwise. External
 * failures throw `ExternalDbError` whose message carries operator guidance
 * and only ever the REDACTED form of the URL.
 */
export async function openDatabase(options: OpenDatabaseOptions): Promise<OpenedDatabase> {
	if (!options.databaseUrl) {
		const db = new PgliteDb(await openPersistentDb(options.dataDir, { reset: options.reset }));
		return {
			db,
			storage: { backend: 'embedded', display: join(options.dataDir, 'pgdata') },
		};
	}

	// Defense in depth — the CLI rejects this combination before startup.
	if (options.reset) {
		throw new ExternalDbError(
			'--reset applies to the embedded database only. For an external database, ' +
				'drop and recreate it with your provider tools, then start Hezo again.',
		);
	}

	const redacted = redactDatabaseUrl(options.databaseUrl);
	let scheme: string;
	try {
		scheme = new URL(options.databaseUrl).protocol;
	} catch {
		scheme = '';
	}
	if (scheme !== 'postgres:' && scheme !== 'postgresql:') {
		throw new ExternalDbError(
			'HEZO_DATABASE_URL / --database-url must be a postgres:// or postgresql:// ' +
				'connection string (e.g. postgres://user:password@host:5432/hezo).',
		);
	}

	const { PostgresDb } = await import('./drivers/postgres');
	const max = parsePoolSize(process.env.HEZO_DATABASE_POOL_SIZE);

	let db: import('./drivers/postgres').PostgresDb | null = null;
	let lastError: unknown;
	for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
		try {
			db = await PostgresDb.connect({ url: options.databaseUrl, max });
			break;
		} catch (err) {
			lastError = err;
			if (attempt < CONNECT_ATTEMPTS) {
				log.warn(
					`Could not reach the external database at ${redacted} (attempt ${attempt}/${CONNECT_ATTEMPTS}); retrying…`,
				);
				await sleep(CONNECT_BACKOFF_MS[attempt - 1]);
			}
		}
	}
	if (!db) {
		const causeMsg = lastError instanceof Error ? lastError.message : String(lastError);
		throw new ExternalDbError(
			`Could not connect to the external database at ${redacted}. ` +
				`Check that the connection string is correct, the server is reachable from this host, ` +
				`and TLS settings match the provider's requirements (most hosted Postgres need ` +
				`sslmode=require or sslmode=verify-full). (cause: ${causeMsg})`,
			lastError,
		);
	}

	try {
		const preflight = await assertExternalPostgresCompatible(db);
		log.info(
			`Using external Postgres at ${redacted} (server ${preflight.serverVersion}, pool max ${max ?? 10})`,
		);
		return {
			db,
			storage: {
				backend: 'external',
				display: redacted,
				server_version: preflight.serverVersion,
			},
		};
	} catch (err) {
		await db.close().catch(() => undefined);
		throw err;
	}
}
