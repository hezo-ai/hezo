/**
 * The storage abstraction every part of the server talks to. Two drivers
 * implement it: `PgliteDb` (embedded PGlite under `<dataDir>/pgdata`, the
 * default) and `PostgresDb` (an external Postgres reached via
 * `--database-url` / the `database.url` config-file key). Application code must only ever
 * depend on this interface — the concrete driver types appear solely in the
 * open/backup/migration plumbing under `src/db/`.
 */

export interface QueryResult<T> {
	rows: T[];
}

export interface Queryable {
	query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
	/** Multi-statement batch (DDL, migrations). No parameters. */
	exec(sql: string): Promise<void>;
}

export interface SessionLockHandle {
	release(): Promise<void>;
}

export interface Db extends Queryable {
	readonly kind: 'pglite' | 'postgres';

	/**
	 * Run `cb` inside a database transaction. While the block runs, every
	 * `query`/`exec` issued from its async context — including closed-over
	 * calls on this `Db` — is routed to the transaction's pinned connection
	 * (AsyncLocalStorage), so helpers called inside the block participate in
	 * the transaction without threading a handle. `cb` also receives the
	 * pinned handle explicitly for code that prefers to be explicit.
	 *
	 * Semantics:
	 * - A nested `transaction()` call **joins** the ambient transaction: no
	 *   new BEGIN, no commit at inner completion — the outermost block owns
	 *   commit/rollback, and an inner throw rolls back the whole block.
	 * - A query issued from async work that outlives its block (e.g. a
	 *   fire-and-forget task spawned inside) throws rather than silently
	 *   running outside the transaction.
	 * - Do not `await` promises created *outside* the block from inside it —
	 *   their queries run on the shared handle/pool, not the transaction.
	 */
	transaction<T>(cb: (tx: Queryable) => Promise<T>): Promise<T>;

	/**
	 * Session-scoped `pg_advisory_lock(key)`. Blocks until acquired; released
	 * by the handle or automatically when the session/process ends. Used to
	 * serialize cross-process work (e.g. external in-place migrations).
	 */
	acquireSessionLock(key: number): Promise<SessionLockHandle>;

	close(): Promise<void>;
}
