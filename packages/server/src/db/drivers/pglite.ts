import type { PGlite, Transaction } from '@electric-sql/pglite';
import type { Db, Queryable, QueryResult } from '../database';
import { TxContext } from './tx-context';

/**
 * Render a JS array as a Postgres array literal, for PGlite's parameter path.
 *
 * PGlite serializes a parameter from the type OID it inferred, and it has no OID
 * for a user-defined enum array - so `['mention','reply']` bound to
 * `$1::wakeup_source[]` reaches the server as `String(array)`, i.e. the braceless
 * `mention,reply`, and the query dies with `malformed array literal`. Built-in
 * element types (`text[]`, `uuid[]`) it does serialize correctly, which is why
 * only the enum-array call sites failed and why the breakage stayed invisible: the
 * node-postgres driver serializes every array properly, so the same query passes
 * on an external Postgres and fails on the embedded default.
 *
 * The literal form is accepted for every element type, so this converts arrays
 * unconditionally rather than sniffing which ones PGlite would have got right.
 * Quoting every element keeps `NULL`, `{`, `,`, `"` and `\` from being read as
 * array syntax; a real SQL NULL is the unquoted keyword, so nulls are emitted
 * bare. Nested arrays recurse, and a `Uint8Array`/`Buffer` bytea parameter is not
 * an Array, so it passes through untouched.
 */
function toPgArrayLiteral(values: readonly unknown[]): string {
	const parts = values.map((v) => {
		if (v === null || v === undefined) return 'NULL';
		if (Array.isArray(v)) return toPgArrayLiteral(v);
		const text = v instanceof Date ? v.toISOString() : String(v);
		return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
	});
	return `{${parts.join(',')}}`;
}

/**
 * The embedded driver's parameter contract, made identical to the node-postgres
 * one. Applied at the single seam every embedded query passes through, so no call
 * site above it has to know which backend it is talking to.
 */
export function encodePgliteParams(params?: unknown[]): unknown[] | undefined {
	if (!params) return params;
	return params.some(Array.isArray)
		? params.map((p) => (Array.isArray(p) ? toPgArrayLiteral(p) : p))
		: params;
}

function wrapPgliteTx(tx: Transaction): Queryable {
	return {
		query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
			return tx.query<T>(sql, encodePgliteParams(params));
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
		// The tx wrapper encodes for itself, so a pinned query must not be encoded
		// twice - a `{a,b}` string would become the literal text `{"{a,b}"}`.
		if (pinned) return pinned.query<T>(sql, params);
		return this.raw.query<T>(sql, encodePgliteParams(params));
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

	async close(): Promise<void> {
		await this.raw.close();
	}
}
