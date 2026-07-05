import type { PGlite, Transaction } from '@electric-sql/pglite';
import type { Db, Queryable, QueryResult, SessionLockHandle } from '../database';
import { TxContext } from './tx-context';

function wrapPgliteTx(tx: Transaction): Queryable {
	return {
		query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
			return tx.query<T>(sql, params);
		},
		async exec(sql: string): Promise<void> {
			await tx.exec(sql);
		},
	};
}

/**
 * The embedded driver: wraps the in-process PGlite instance that lives under
 * `<dataDir>/pgdata` (or in memory, in tests). PGlite is a single serialized
 * connection, so `transaction()` maps onto PGlite's native `.transaction()`,
 * which holds the engine's exclusive lock for the whole block — concurrent
 * queries queue until commit instead of interleaving into the open
 * transaction (which raw BEGIN/COMMIT sequencing used to allow).
 *
 * `raw` stays exposed for the embedded-only machinery that genuinely needs
 * the concrete instance: `dumpDataDir` backups, the copy-migrate-swap
 * runner, and the test snapshot cache.
 */
export class PgliteDb implements Db {
	readonly kind = 'pglite' as const;
	private readonly txContext = new TxContext();

	constructor(readonly raw: PGlite) {}

	// `async` so a tx-context violation surfaces as a rejection, never a
	// synchronous throw out of a method that promises a Promise.
	async query<T = Record<string, unknown>>(
		sql: string,
		params?: unknown[],
	): Promise<QueryResult<T>> {
		const pinned = this.txContext.current();
		if (pinned) return pinned.query<T>(sql, params);
		return this.raw.query<T>(sql, params);
	}

	async exec(sql: string): Promise<void> {
		const pinned = this.txContext.current();
		if (pinned) return pinned.exec(sql);
		await this.raw.exec(sql);
	}

	async transaction<T>(cb: (tx: Queryable) => Promise<T>): Promise<T> {
		const ambient = this.txContext.current();
		if (ambient) return cb(ambient); // join: the outermost block owns commit/rollback
		return this.raw.transaction((pgTx) => {
			const tx = wrapPgliteTx(pgTx);
			return this.txContext.run(tx, () => cb(tx));
		});
	}

	async acquireSessionLock(key: number): Promise<SessionLockHandle> {
		await this.raw.query('SELECT pg_advisory_lock($1)', [key]);
		return {
			release: async () => {
				await this.raw.query('SELECT pg_advisory_unlock($1)', [key]);
			},
		};
	}

	async close(): Promise<void> {
		await this.raw.close();
	}
}
