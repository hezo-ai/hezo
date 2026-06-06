/**
 * A minimal Kysely dialect that runs over an *existing* PGlite instance.
 *
 * PGlite is embedded (WASM Postgres in-process), so Kysely's stock Postgres
 * dialect — which dials a TCP `pg` pool — doesn't apply. PGlite speaks real
 * Postgres SQL, though, so we reuse Kysely's `PostgresAdapter`,
 * `PostgresQueryCompiler` and `PostgresIntrospector` (parameter style, casts,
 * `RETURNING`, `information_schema` introspection all match) and only supply a
 * driver that forwards compiled queries to `pglite.query`.
 *
 * The PGlite instance is owned by the caller (created once at startup, shared
 * across the app), so `destroy()` is a no-op — closing it is the owner's job.
 * PGlite is a single connection with no nesting, so the one connection is
 * shared and transactions issue plain BEGIN/COMMIT/ROLLBACK, matching the
 * semantics of the existing `withTransaction` helper.
 */
import type { PGlite } from '@electric-sql/pglite';
import {
	type CompiledQuery,
	CompiledQuery as CompiledQueryHelper,
	type DatabaseConnection,
	type DatabaseIntrospector,
	type Dialect,
	type DialectAdapter,
	type Driver,
	type Kysely,
	PostgresAdapter,
	PostgresIntrospector,
	PostgresQueryCompiler,
	type QueryCompiler,
	type QueryResult,
} from 'kysely';

class PGliteConnection implements DatabaseConnection {
	constructor(private readonly client: PGlite) {}

	async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
		const result = await this.client.query<R>(compiledQuery.sql, [...compiledQuery.parameters]);
		const affected = result.affectedRows;
		return {
			rows: result.rows,
			numAffectedRows: affected === undefined ? undefined : BigInt(affected),
		};
	}

	// PGlite has no server-side cursor we can stream incrementally; the
	// repository layer never streams, so this stays unsupported rather than
	// silently buffering an entire result under the guise of streaming.
	streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
		throw new Error('PGlite dialect does not support streaming queries');
	}
}

class PGliteDriver implements Driver {
	private readonly connection: PGliteConnection;

	constructor(client: PGlite) {
		this.connection = new PGliteConnection(client);
	}

	async init(): Promise<void> {}

	async acquireConnection(): Promise<DatabaseConnection> {
		return this.connection;
	}

	async beginTransaction(connection: DatabaseConnection): Promise<void> {
		await connection.executeQuery(CompiledQueryHelper.raw('begin'));
	}

	async commitTransaction(connection: DatabaseConnection): Promise<void> {
		await connection.executeQuery(CompiledQueryHelper.raw('commit'));
	}

	async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
		await connection.executeQuery(CompiledQueryHelper.raw('rollback'));
	}

	async releaseConnection(): Promise<void> {}

	async destroy(): Promise<void> {}
}

/** Kysely dialect backed by an already-open PGlite instance. */
export class PGliteDialect implements Dialect {
	constructor(private readonly client: PGlite) {}

	createDriver(): Driver {
		return new PGliteDriver(this.client);
	}

	createQueryCompiler(): QueryCompiler {
		return new PostgresQueryCompiler();
	}

	createAdapter(): DialectAdapter {
		return new PostgresAdapter();
	}

	createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
		return new PostgresIntrospector(db);
	}
}
