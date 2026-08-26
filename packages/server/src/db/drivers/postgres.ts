import pg from 'pg';
import type { Db, Queryable, QueryResult } from '../database';
import { normalizePostgresUrl } from '../postgres-url';
import { TxContext } from './tx-context';

// Parser parity with PGlite (the conformance suite is the executable
// contract): stock node-postgres returns int8 as a string, but PGlite parses
// it to a number and app code does math on uncast COUNT(*)/BIGINT values.
// Hezo's bigint columns hold token/byte counts — far below 2^53, so Number is
// lossless in practice. Module-level on purpose: it must apply before any
// pool issues its first query.
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => Number(value));

/**
 * Pool floor.
 *
 * One connection is enough: the only thing that ever held a second was the
 * migration lock, which is now transaction-scoped and lives on the connection
 * its own transaction already has. A pool of one serializes every query in the
 * process, so it is a deliberate choice for a dense deployment, not a default.
 *
 * **What makes one safe rather than merely tight.** A pool of one deadlocks the
 * moment anything holds a connection and then waits for a second, so the
 * question is whether any code does. Audited at the eight `transaction()` call
 * sites outside this file - `crypto/master-key.ts`, `db/logical-backup.ts`,
 * `db/migrate.ts`, `db/migrate-external.ts`, `lib/asset-name.ts`, `lib/sql.ts`
 * and `services/log-compaction.ts` - and none does, for a structural reason
 * rather than by inspection surviving the next edit:
 *
 * - `transaction()` pins its connection in AsyncLocalStorage, so a `db.query`
 *   issued from inside the block joins the transaction rather than asking the
 *   pool for another one. That covers closed-over helpers, which is where this
 *   would otherwise hide.
 * - A nested `transaction()` joins the ambient one; it does not open a second.
 * - A query from async work that OUTLIVES its block throws rather than quietly
 *   running outside the transaction, so the one shape that could still want a
 *   second connection fails loudly instead of hanging.
 *
 * The trap left is a promise created OUTSIDE a block and awaited inside it: its
 * queries run on the pool, and at a floor of one they wait for a connection the
 * awaiting block is holding. The `Db.transaction` doc says not to; nothing does.
 */
const MIN_POOL_SIZE = 1;

export interface PostgresConnectOptions {
	url: string;
	/** Pool size (default 10, floor 1 — see MIN_POOL_SIZE). */
	max?: number;
}

function wrapClient(client: pg.PoolClient): Queryable {
	return {
		async query<T = Record<string, unknown>>(
			sql: string,
			params?: unknown[],
		): Promise<QueryResult<T>> {
			const result = await client.query(sql, params as unknown[] | undefined);
			return { rows: result.rows as T[] };
		},
		async exec(sql: string): Promise<void> {
			// No parameters ⇒ simple query protocol ⇒ multi-statement batches work.
			await client.query(sql);
		},
	};
}

/**
 * The external driver: a `pg.Pool` against a hosted Postgres. Plain queries
 * ride the pool; `transaction()` checks out one client, pins it in the
 * async context (see `TxContext`) so closed-over `db.query` calls inside the
 * block join the transaction, and releases it on commit/rollback. Errors are
 * rethrown untouched — `isFkViolation`/`isUniqueViolation` read pg's
 * `DatabaseError.code`/`.constraint` directly.
 */
export class PostgresDb implements Db {
	readonly kind = 'postgres' as const;
	private readonly txContext = new TxContext();
	/** Tail of the in-process transaction queue — see transaction(). */
	private txQueue: Promise<unknown> = Promise.resolve();

	private constructor(private readonly pool: pg.Pool) {}

	/** Create the pool and prove basic connectivity with one round-trip. */
	static async connect(options: PostgresConnectOptions): Promise<PostgresDb> {
		const url = new URL(options.url);
		// Every pool in the codebase is built here, so normalizing the string at
		// this one point makes libpq `sslmode` semantics unbypassable. Note that
		// an explicit `ssl` option alongside `connectionString` would NOT work:
		// node-postgres merges the parsed string over the caller's config, so a
		// URL carrying `sslmode` silently wins.
		const pool = new pg.Pool({
			connectionString: normalizePostgresUrl(options.url).url,
			max: Math.max(MIN_POOL_SIZE, options.max ?? 10),
			// Checkout starvation (e.g. a transaction leak eating the pool) must
			// fail loudly, not hang requests forever.
			connectionTimeoutMillis: 10_000,
			...(url.searchParams.has('application_name') ? {} : { application_name: 'hezo' }),
		});
		try {
			await pool.query('SELECT 1');
		} catch (err) {
			await pool.end().catch(() => undefined);
			throw err;
		}
		return new PostgresDb(pool);
	}

	async query<T = Record<string, unknown>>(
		sql: string,
		params?: unknown[],
	): Promise<QueryResult<T>> {
		const pinned = this.txContext.current();
		if (pinned) return pinned.query<T>(sql, params);
		const result = await this.pool.query(sql, params as unknown[] | undefined);
		return { rows: result.rows as T[] };
	}

	async exec(sql: string): Promise<void> {
		const pinned = this.txContext.current();
		if (pinned) return pinned.exec(sql);
		await this.pool.query(sql);
	}

	async transaction<T>(cb: (tx: Queryable) => Promise<T>): Promise<T> {
		const ambient = this.txContext.current();
		if (ambient) return cb(ambient); // join: the outermost block owns commit/rollback

		// Whole blocks serialize in-process, exactly like the embedded engine.
		// The app's transactions were written against PGlite's exclusive lock —
		// unlocked read-modify-write blocks would silently lose updates under
		// the pool's READ COMMITTED concurrency (the conformance suite's
		// serialization test catches precisely this). Plain queries still ride
		// the pool concurrently; only transaction blocks queue, and they are
		// tight DB sequences. Cross-INSTANCE serialization is out of scope —
		// Hezo runs one server per database (migrations, the multi-writer case,
		// take a transaction-scoped advisory lock of their own).
		const run = () => this.runExclusiveTransaction(cb);
		const result = this.txQueue.then(run, run);
		this.txQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async runExclusiveTransaction<T>(cb: (tx: Queryable) => Promise<T>): Promise<T> {
		const client = await this.pool.connect();
		const tx = wrapClient(client);
		let dispose: Error | undefined;
		try {
			await client.query('BEGIN');
			try {
				const result = await this.txContext.run(tx, () => cb(tx));
				await client.query('COMMIT');
				return result;
			} catch (err) {
				try {
					await client.query('ROLLBACK');
				} catch (rollbackErr) {
					// A failed ROLLBACK means the connection state is unknown — have
					// the pool destroy it instead of recycling it.
					dispose = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
				}
				throw err;
			}
		} finally {
			client.release(dispose);
		}
	}

	async close(): Promise<void> {
		await this.pool.end();
	}
}
