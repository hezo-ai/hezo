import { join } from 'node:path';
import { runtimeConfig } from '../config/runtime';
import { redactDatabaseUrl, type StorageInfo } from '../lib/db-info';
import { logger } from '../logger';
import { openPersistentDb } from './client';
import type { Db } from './database';
import { PgliteDb } from './drivers/pglite';
import { ExternalDbError } from './migrate-errors';
import { connectFailureHint, isRetryableConnectError } from './postgres-connect-errors';
import { assertExternalPostgresCompatible } from './postgres-preflight';
import { describeTlsPosture, normalizePostgresUrl } from './postgres-url';

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

/**
 * The single startup entry for the storage layer: embedded PGlite when no URL
 * is configured (the default — zero change for existing installs), external
 * Postgres via `--database-url` / the config file's `database.url` otherwise. External
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
			"--database-url / the config file's database.url must be a postgres:// or postgresql:// " +
				'connection string (e.g. postgres://user:password@host:5432/hezo).',
		);
	}

	const { PostgresDb } = await import('./drivers/postgres');
	const max = runtimeConfig().database.poolSize;

	let db: import('./drivers/postgres').PostgresDb | null = null;
	let lastError: unknown;
	for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
		try {
			db = await PostgresDb.connect({ url: options.databaseUrl, max });
			break;
		} catch (err) {
			lastError = err;
			// A rejected certificate or bad credentials fail identically on every
			// attempt — spending the backoff on them only delays the guidance.
			if (!isRetryableConnectError(err)) break;
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
		const hint =
			connectFailureHint(lastError) ??
			'Check that the connection string is correct and the server is reachable from this host.';
		throw new ExternalDbError(
			`Could not connect to the external database at ${redacted}. ${hint} (cause: ${causeMsg})`,
			lastError,
		);
	}

	try {
		const preflight = await assertExternalPostgresCompatible(db);
		// The effective TLS posture is stated on every boot: `sslmode=require`
		// encrypts without authenticating the server, and that is worth seeing
		// rather than assuming.
		const tls = describeTlsPosture(normalizePostgresUrl(options.databaseUrl).tls);
		log.info(
			`Using external Postgres at ${redacted} (server ${preflight.serverVersion}, pool max ${max ?? 10}, ${tls})`,
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
