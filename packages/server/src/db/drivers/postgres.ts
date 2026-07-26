import pg from 'pg';
import type { Db, Queryable, QueryResult, SessionLockHandle } from '../database';
import { isSslUnsupportedError, type PostgresTlsPosture, planPostgresSsl } from '../postgres-ssl';
import { TxContext } from './tx-context';

// Parser parity with PGlite (the conformance suite is the executable
// contract): stock node-postgres returns int8 as a string, but PGlite parses
// it to a number and app code does math on uncast COUNT(*)/BIGINT values.
// Hezo's bigint columns hold token/byte counts — far below 2^53, so Number is
// lossless in practice. Module-level on purpose: it must apply before any
// pool issues its first query.
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => Number(value));

/** Pool floor: `transaction()` pins one client while `acquireSessionLock` holds another. */
const MIN_POOL_SIZE = 2;

export interface PostgresConnectOptions {
	url: string;
	/** Pool size (default 10, floor 2 — see MIN_POOL_SIZE). */
	max?: number;
}

/** `sslnegotiation` is a real pg option that @types/pg does not declare yet. */
type PoolConfig = pg.PoolConfig & { sslnegotiation?: 'postgres' | 'direct' };

function hasApplicationName(url: string): boolean {
	try {
		return new URL(url).searchParams.has('application_name');
	} catch {
		return false;
	}
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

	private constructor(
		private readonly pool: pg.Pool,
		/** TLS posture actually in force on this pool (after any fallback). */
		readonly tls: PostgresTlsPosture,
	) {}

	/**
	 * Create the pool and prove basic connectivity with one round-trip.
	 *
	 * TLS is tolerant by default (see `planPostgresSsl`): it is attempted even
	 * when the URL says nothing about it — so a hosted database that requires
	 * TLS or presents an unknown/self-signed/mismatched certificate connects —
	 * and a server that cannot do TLS at all is retried in plaintext.
	 */
	static async connect(options: PostgresConnectOptions): Promise<PostgresDb> {
		const plan = planPostgresSsl(options.url);
		const build = (ssl: PoolConfig['ssl']): pg.Pool =>
			new pg.Pool({
				connectionString: plan.connectionString,
				ssl,
				...(ssl && plan.sslNegotiation ? { sslnegotiation: plan.sslNegotiation } : {}),
				max: Math.max(MIN_POOL_SIZE, options.max ?? 10),
				// Checkout starvation (e.g. a transaction leak eating the pool) must
				// fail loudly, not hang requests forever.
				connectionTimeoutMillis: 10_000,
				...(hasApplicationName(options.url) ? {} : { application_name: 'hezo' }),
			} satisfies PoolConfig);

		const probe = async (pool: pg.Pool): Promise<void> => {
			try {
				await pool.query('SELECT 1');
			} catch (err) {
				await pool.end().catch(() => undefined);
				throw err;
			}
		};

		const pool = build(plan.ssl);
		try {
			await probe(pool);
		} catch (err) {
			// The server answered the SSLRequest with "no". Nothing in the URL
			// demanded TLS, so connect the way the server can.
			if (!plan.plaintextFallback || !isSslUnsupportedError(err)) throw err;
			const plaintext = build(false);
			await probe(plaintext);
			return new PostgresDb(plaintext, 'none');
		}
		return new PostgresDb(pool, plan.tls);
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
		// take a pg_advisory_lock).
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

	async acquireSessionLock(key: number): Promise<SessionLockHandle> {
		// Advisory locks are session-scoped, so the holder must be one dedicated
		// client — taking the lock through the pool would bind it to a random
		// connection that the next query no longer uses.
		const client = await this.pool.connect();
		try {
			await client.query('SELECT pg_advisory_lock($1)', [key]);
		} catch (err) {
			client.release(err instanceof Error ? err : new Error(String(err)));
			throw err;
		}
		return {
			release: async () => {
				try {
					await client.query('SELECT pg_advisory_unlock($1)', [key]);
					client.release();
				} catch (err) {
					// Destroy the connection — the session dying releases the lock.
					client.release(err instanceof Error ? err : new Error(String(err)));
				}
			},
		};
	}

	async close(): Promise<void> {
		await this.pool.end();
	}
}
