import type { Queryable } from './database';
import { ExternalDbError } from './migrate-errors';

/**
 * PG 14 is the supported floor. The SQL itself needs only 13
 * (`gen_random_uuid()` in core) and 12 (generated columns), but 13 is EOL —
 * requiring a maintained major keeps the support surface honest.
 */
export const MIN_SERVER_VERSION_NUM = 140_000;

export interface PostgresPreflightResult {
	serverVersionNum: number;
	/** Human-readable `server_version` setting, e.g. "16.4". */
	serverVersion: string;
}

/**
 * Assert a freshly connected external Postgres can run Hezo: version floor and
 * a `gen_random_uuid()` smoke test (the schema defaults every primary key to
 * it). Runs before BASE_SCHEMA/migrations so incompatibility fails fast with
 * operator guidance instead of a mid-migration SQL error.
 */
export async function assertExternalPostgresCompatible(
	db: Queryable,
): Promise<PostgresPreflightResult> {
	const version = await db.query<{ num: number; version: string }>(
		`SELECT current_setting('server_version_num')::int AS num,
		        current_setting('server_version') AS version`,
	);
	const { num, version: serverVersion } = version.rows[0];
	if (num < MIN_SERVER_VERSION_NUM) {
		throw new ExternalDbError(
			`Hezo requires PostgreSQL ${Math.floor(MIN_SERVER_VERSION_NUM / 10_000)} or newer; ` +
				`the server at --database-url reports ${serverVersion}. ` +
				`Upgrade the database (managed providers offer in-place major upgrades) and retry.`,
		);
	}

	try {
		await db.query('SELECT gen_random_uuid()');
	} catch (cause) {
		throw new ExternalDbError(
			`The external Postgres cannot run gen_random_uuid(), which Hezo's schema requires. ` +
				`On PostgreSQL ${serverVersion} this is built in — the failure suggests a ` +
				`non-standard distribution or restricted permissions. (cause: ${
					cause instanceof Error ? cause.message : String(cause)
				})`,
			cause,
		);
	}

	return { serverVersionNum: num, serverVersion };
}
