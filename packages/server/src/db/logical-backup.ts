import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { createGunzip, createGzip } from 'node:zlib';
import type { ProgressCallback } from '../lib/progress';
import type { Db, Queryable } from './database';
import { checksumOfMigration, type Migration, runMigrations } from './migrate';
import { BackupNewerThanAppError, RestorePreconditionError } from './migrate-errors';
import { BASE_SCHEMA } from './schema';

/**
 * Portable logical backup — one format for BOTH storage backends.
 *
 * The embedded backup used to be a physical PGlite datadir tarball, which no
 * hosted Postgres can read. This format is logical and schema-versioned:
 * schema is not dumped at all (it is reproduced by replaying Hezo's own
 * migrations up to the set recorded in the header), and data travels as typed
 * row records. Everything runs through the `Db` interface, so a backup taken
 * on one backend restores onto the other — which is also how an instance
 * moves between embedded PGlite and hosted Postgres.
 *
 * Format v1 (gzipped JSONL): line 1 is the header
 * `{ formatVersion, hezoVersion, createdAt, migrations, tables }`, every
 * further line is `{ "t": <table>, "r": <row> }`. Encoding: bytea → base64,
 * timestamptz/date → ISO strings, jsonb kept as JSON, arrays as JSON arrays.
 * Generated columns (the tsvector search columns) are excluded — the engine
 * recomputes them on insert. `_migrations` rows are excluded too — the
 * restore's migration replay recreates that bookkeeping.
 */

const FORMAT_VERSION = 1;
const DUMP_PAGE_SIZE = 5_000;
const INSERT_BATCH_SIZE = 500;

/**
 * Rows between progress reports while parsing the dump. Parsing is a tight loop
 * over millions of lines, so it reports on a row interval rather than per row;
 * the reporter throttles rendering on top of that.
 */
const PARSE_PROGRESS_ROWS = 20_000;

/**
 * Ceiling on the data volume a single dump query may return / a single restore
 * INSERT may carry. Embedded PGlite hard-crashes its WASM instance
 * ("RuntimeError: Out of bounds memory access") when one protocol message
 * exceeds roughly 16MB, so both directions size their batches by bytes as well
 * as rows, with generous headroom under that ceiling. Large-log tables (a
 * single agent run's log can be megabytes) are what make row-count-only
 * batching unsafe.
 */
const BATCH_TARGET_BYTES = 4 * 1024 * 1024;

/**
 * Rows per page for one table's dump queries: as many rows as fit the byte
 * target given the table's average row size, at least 1 and at most the flat
 * row cap. A table whose largest single row alone exceeds the target is read
 * one row at a time — the best a row-granular reader can do.
 */
export function dumpPageRows(stats: {
	rowCount: number;
	totalBytes: number;
	maxRowBytes: number;
}): number {
	if (stats.rowCount === 0) return DUMP_PAGE_SIZE;
	if (stats.maxRowBytes > BATCH_TARGET_BYTES) return 1;
	const avgRowBytes = Math.max(1, Math.ceil(stats.totalBytes / stats.rowCount));
	return Math.min(DUMP_PAGE_SIZE, Math.max(1, Math.floor(BATCH_TARGET_BYTES / avgRowBytes)));
}

/**
 * Split `sizes.length` rows into contiguous insert batches, closing a batch
 * when it reaches the row cap or the cumulative byte target. Every batch holds
 * at least one row, so a single oversized row still travels (alone).
 */
export function planInsertBatches(
	sizes: number[],
	maxRows = INSERT_BATCH_SIZE,
	targetBytes = BATCH_TARGET_BYTES,
): Array<{ start: number; end: number }> {
	const batches: Array<{ start: number; end: number }> = [];
	let start = 0;
	let bytes = 0;
	for (let i = 0; i < sizes.length; i++) {
		const rowsInBatch = i - start;
		if (rowsInBatch > 0 && (rowsInBatch >= maxRows || bytes + sizes[i] > targetBytes)) {
			batches.push({ start, end: i });
			start = i;
			bytes = 0;
		}
		bytes += sizes[i];
	}
	if (start < sizes.length) batches.push({ start, end: sizes.length });
	return batches;
}

interface ColumnMeta {
	name: string;
	udt: string;
	generated: boolean;
	serial: boolean;
}

interface TableMeta {
	name: string;
	columns: ColumnMeta[];
	pk: string[];
}

export interface LogicalBackupHeader {
	formatVersion: number;
	hezoVersion: string;
	createdAt: string;
	migrations: Array<{ filename: string; checksum: string }>;
	tables: Array<{ name: string; columns: string[] }>;
}

export interface RestoreSummary {
	tables: number;
	rows: number;
}

async function introspectTables(db: Queryable): Promise<TableMeta[]> {
	const tables = await db.query<{ table_name: string }>(
		`SELECT table_name FROM information_schema.tables
		 WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
		 ORDER BY table_name COLLATE "C"`,
	);
	const columns = await db.query<{
		table_name: string;
		column_name: string;
		udt_name: string;
		is_generated: string;
		column_default: string | null;
	}>(
		`SELECT table_name, column_name, udt_name, is_generated, column_default
		 FROM information_schema.columns
		 WHERE table_schema = 'public'
		 ORDER BY table_name COLLATE "C", ordinal_position`,
	);
	const pks = await db.query<{ table_name: string; column_name: string }>(
		`SELECT tc.table_name, kcu.column_name
		 FROM information_schema.table_constraints tc
		 JOIN information_schema.key_column_usage kcu
		   ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
		 WHERE tc.table_schema = 'public' AND tc.constraint_type = 'PRIMARY KEY'
		 ORDER BY tc.table_name COLLATE "C", kcu.ordinal_position`,
	);

	const byTable = new Map<string, TableMeta>();
	for (const t of tables.rows) {
		byTable.set(t.table_name, { name: t.table_name, columns: [], pk: [] });
	}
	for (const c of columns.rows) {
		byTable.get(c.table_name)?.columns.push({
			name: c.column_name,
			udt: c.udt_name,
			generated: c.is_generated === 'ALWAYS',
			serial: (c.column_default ?? '').startsWith('nextval('),
		});
	}
	for (const pk of pks.rows) {
		byTable.get(pk.table_name)?.pk.push(pk.column_name);
	}
	return [...byTable.values()];
}

function quoteIdent(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

function encodeValue(value: unknown, udt: string): unknown {
	if (value === null || value === undefined) return null;
	if (udt === 'bytea') {
		return Buffer.from(value as Uint8Array).toString('base64');
	}
	if (value instanceof Date) return value.toISOString();
	return value;
}

function decodeValue(value: unknown, udt: string): unknown {
	if (value === null) return null;
	if (udt === 'bytea') return Buffer.from(value as string, 'base64');
	// jsonb/json columns need an explicit string + ::jsonb cast — a JS array
	// inside a jsonb value would otherwise be serialized as a Postgres array.
	if (udt === 'jsonb' || udt === 'json') return JSON.stringify(value);
	return value;
}

/**
 * Yield the backup as newline-terminated JSONL lines, a page of rows at a time.
 *
 * This is the memory-safe core of the dump, and it must stay a generator. The
 * dump used to accumulate every row of the database into one `string[]`, join it
 * into a single giant string, then gzip that — three full copies of the
 * uncompressed database resident at once, on top of V8's per-string overhead for
 * millions of array entries. On a small VPS that is an OOM kill (exit 137), and
 * because the pre-migration backup runs on the startup path, the kill lands
 * mid-upgrade: the supervisor restarts, dumps again, is killed again, forever.
 * Streaming keeps resident memory at roughly one page (~4MB) regardless of how
 * large the instance is.
 */
export async function* streamLogicalBackupLines(
	db: Queryable,
	meta: { hezoVersion: string; migrations: Record<string, Migration> },
): AsyncGenerator<string> {
	const tables = await introspectTables(db);
	const applied = await db.query<{ filename: string; checksum: string }>(
		`SELECT filename, checksum FROM _migrations ORDER BY id`,
	);

	const header: LogicalBackupHeader = {
		formatVersion: FORMAT_VERSION,
		hezoVersion: meta.hezoVersion,
		createdAt: new Date().toISOString(),
		migrations: applied.rows,
		tables: tables
			.filter((t) => t.name !== '_migrations')
			.map((t) => ({
				name: t.name,
				columns: t.columns.filter((c) => !c.generated).map((c) => c.name),
			})),
	};

	yield `${JSON.stringify(header)}\n`;
	for (const table of tables) {
		if (table.name === '_migrations') continue;
		const cols = table.columns.filter((c) => !c.generated);
		const colList = cols.map((c) => quoteIdent(c.name)).join(', ');
		const orderBy =
			table.pk.length > 0 ? `ORDER BY ${table.pk.map((c) => quoteIdent(c)).join(', ')}` : '';

		try {
			// Page size is derived from the table's *uncompressed* row sizes
			// (rendering the whole row to text detoasts it), so one page's
			// response stays well under the embedded engine's per-message
			// ceiling regardless of how large individual rows are. Only the
			// aggregates travel back here, so this probe itself is safe on any
			// table.
			const stats = await db.query<{
				row_count: number;
				total_bytes: string;
				max_row_bytes: number;
			}>(
				`SELECT COUNT(*)::int AS row_count,
				        COALESCE(SUM(octet_length(__hezo_row::text)), 0)::text AS total_bytes,
				        COALESCE(MAX(octet_length(__hezo_row::text)), 0)::int AS max_row_bytes
				 FROM ${quoteIdent(table.name)} AS __hezo_row`,
			);
			const pageRows = dumpPageRows({
				rowCount: stats.rows[0].row_count,
				totalBytes: Number(stats.rows[0].total_bytes),
				maxRowBytes: stats.rows[0].max_row_bytes,
			});

			let offset = 0;
			for (;;) {
				// Keyset pagination would be nicer, but OFFSET paging with a
				// stable PK order is correct at backup scale. Tables with no PK
				// are read in one page.
				const page = await db.query<Record<string, unknown>>(
					orderBy
						? `SELECT ${colList} FROM ${quoteIdent(table.name)} ${orderBy} LIMIT ${pageRows} OFFSET ${offset}`
						: `SELECT ${colList} FROM ${quoteIdent(table.name)}`,
				);
				for (const row of page.rows) {
					const encoded: Record<string, unknown> = {};
					for (const col of cols) {
						encoded[col.name] = encodeValue(row[col.name], col.udt);
					}
					// Yielding per row (rather than per page) is what lets the consumer
					// apply back-pressure: the gzip stream and the file write decide how
					// fast rows are produced, so nothing queues up behind a slow disk.
					yield `${JSON.stringify({ t: table.name, r: encoded })}\n`;
				}
				if (!orderBy || page.rows.length < pageRows) break;
				offset += pageRows;
			}
		} catch (err) {
			const causeMsg = err instanceof Error ? err.message : String(err);
			throw new Error(`Dumping table "${table.name}" failed: ${causeMsg}`, { cause: err });
		}
	}
}

/**
 * Write a logical backup straight to `filePath`, gzipped, in constant memory.
 *
 * This is the only dump form: the startup pre-migration backup and the `hezo
 * backup` CLI both use it. Collecting the whole dump into a Buffer first is what
 * OOM-killed small hosts mid-upgrade, so that form no longer exists.
 */
export async function dumpLogicalBackupToFile(
	db: Db,
	filePath: string,
	meta: { hezoVersion: string; migrations: Record<string, Migration> },
): Promise<void> {
	// One transaction, one snapshot, for the whole dump.
	//
	// The dump reads table by table. Without a snapshot a migration committing
	// partway through leaves some tables read before it and some after, and the
	// file restores into a database that never existed - which is worse than
	// having no backup, because it restores. REPEATABLE READ fixes the read to a
	// single instant, so a concurrent migration commits freely and is simply not
	// seen. Nobody is blocked from migrating; they are only blocked from being
	// half-visible.
	//
	// `tx` is threaded through explicitly rather than left to the ambient
	// transaction: the generator's queries are pulled by the stream's own read
	// loop, and a query that reached the pool instead would ask for a second
	// connection while this transaction holds one - a hang at `poolSize: 1`
	// rather than a wrong answer.
	await db.transaction(async (tx) => {
		await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
		await pipeline(
			Readable.from(streamLogicalBackupLines(tx, meta), { objectMode: false }),
			createGzip(),
			createWriteStream(filePath),
		);
	});
}

/**
 * Read just the header of a gzipped backup FILE, decompressing only as far as
 * the first newline. Null when the file isn't a logical backup at all - which is
 * how the restore CLI identifies its input, and rejects anything else, without
 * decompressing a multi-GB body.
 */
export async function peekLogicalBackupHeaderFromFile(
	filePath: string,
): Promise<LogicalBackupHeader | null> {
	const iterator = linesOfGzipFile(filePath)[Symbol.asyncIterator]();
	try {
		const first = await iterator.next();
		if (first.done) return null;
		const header = JSON.parse(first.value) as LogicalBackupHeader;
		return typeof header.formatVersion === 'number' && Array.isArray(header.migrations)
			? header
			: null;
	} catch {
		return null;
	} finally {
		await iterator.return?.(undefined);
	}
}

export interface RestoreLogicalBackupOptions {
	wipe?: boolean;
	/**
	 * Phase/counter updates for a terminal progress line. A restore of a large
	 * instance is minutes of silence otherwise (see `lib/progress.ts`).
	 */
	onProgress?: ProgressCallback;
}

/**
 * Restore a logical backup into `db`, from either the gzipped bytes or the
 * already-decompressed JSONL text. The target must be empty (no tables in
 * `public`) unless `wipe` is set, which drops and recreates the schema first.
 * Schema is reproduced by replaying the binary's own migrations up to exactly
 * the set the backup recorded (a backup carrying unknown migrations refuses —
 * upgrade the binary). Data loads inside ONE transaction with FK constraints
 * dropped and re-added around the inserts, so insert order (including
 * self-referencing rows) never matters; migration-seeded rows are truncated
 * first so the backup's rows are authoritative.
 */
/**
 * Lines of a gzipped backup file, decompressed incrementally off disk so the
 * uncompressed body never exists as a single string.
 *
 * `StringDecoder` (not `chunk.toString()`) because a gzip chunk boundary lands
 * mid-codepoint often enough to matter - the dump carries arbitrary user text.
 */
async function* linesOfGzipFile(
	filePath: string,
	onBytes?: (compressedBytes: number) => void,
): AsyncGenerator<string> {
	const file = createReadStream(filePath);
	let compressed = 0;
	file.on('data', (chunk: string | Buffer) => {
		compressed += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
		onBytes?.(compressed);
	});
	const decoder = new StringDecoder('utf8');
	let carry = '';
	for await (const chunk of file.pipe(createGunzip())) {
		carry += decoder.write(chunk as Buffer);
		let start = 0;
		for (;;) {
			const nl = carry.indexOf('\n', start);
			if (nl === -1) break;
			yield carry.slice(start, nl);
			start = nl + 1;
		}
		carry = carry.slice(start);
	}
	carry += decoder.end();
	if (carry) yield carry;
}

/**
 * Restore from a gzipped backup FILE, streaming it off disk.
 *
 * This is the only restore form. It replaced one that took the backup as a
 * Buffer or string, which needed the whole compressed buffer, the whole
 * uncompressed buffer AND the whole uncompressed string resident at once.
 * Restore is the recovery path, so it has to work on a host that is already
 * short on memory - including one that just failed an upgrade for that reason.
 */
export async function restoreLogicalBackupFromFile(
	db: Db,
	filePath: string,
	binaryMigrations: Record<string, Migration>,
	options: RestoreLogicalBackupOptions = {},
): Promise<RestoreSummary> {
	let compressedBytes = 0;
	return restoreFromLines(
		db,
		linesOfGzipFile(filePath, (bytes) => {
			compressedBytes = bytes;
		}),
		binaryMigrations,
		options,
		() => compressedBytes,
	);
}

/**
 * The restore engine, driven by a line stream.
 *
 * Rows are inserted as they are read, never collected first: the dump writes
 * one table at a time, so a batch is flushed when it reaches the row cap or the
 * byte target, and whenever the stream moves to a different table. Buffering
 * every row of the database as decoded objects before the first INSERT (which
 * this used to do) is a multiple of the database in resident memory.
 */
async function restoreFromLines(
	db: Db,
	lines: AsyncIterable<string>,
	binaryMigrations: Record<string, Migration>,
	options: RestoreLogicalBackupOptions,
	consumedBytes?: () => number,
): Promise<RestoreSummary> {
	const progress: ProgressCallback = options.onProgress ?? (() => {});
	const iterator = lines[Symbol.asyncIterator]();

	const first = await iterator.next();
	if (first.done) throw new RestorePreconditionError('The backup is empty.');
	const header = JSON.parse(first.value) as LogicalBackupHeader;
	if (header.formatVersion !== FORMAT_VERSION) {
		throw new RestorePreconditionError(
			`This backup uses format v${header.formatVersion}; this Hezo build reads v${FORMAT_VERSION}. ` +
				`Restore it with a matching Hezo version.`,
		);
	}

	const unknown = header.migrations.map((m) => m.filename).filter((f) => !(f in binaryMigrations));
	if (unknown.length > 0) {
		throw new BackupNewerThanAppError(unknown);
	}
	// Frozen-migration policy check: a checksum mismatch on a known filename
	// means the backup came from a build with different SQL for the same name.
	for (const m of header.migrations) {
		const local = checksumOfMigration(binaryMigrations[m.filename]);
		if (local !== m.checksum) {
			throw new RestorePreconditionError(
				`Migration ${m.filename} in this backup has a different checksum than this binary's copy. ` +
					`Restore with the Hezo version that created the backup.`,
			);
		}
	}

	const existing = await db.query<{ c: number }>(
		`SELECT COUNT(*)::int AS c FROM information_schema.tables
		 WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
	);
	if (existing.rows[0].c > 0) {
		if (!options.wipe) {
			throw new RestorePreconditionError(
				`The target database is not empty (${existing.rows[0].c} tables). ` +
					`Pass --wipe to drop the existing schema and restore over it, or point at an empty database.`,
			);
		}
		progress({ phase: 'wipe', label: 'Dropping the existing schema' });
		await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
	}

	// Reproduce the schema at exactly the backup's migration set. Announced (not
	// counted) because `runMigrations` logs a line per migration itself.
	progress({
		phase: 'schema',
		label: 'Recreating the schema',
		detail: `${header.migrations.length} migrations`,
	});
	await db.exec(BASE_SCHEMA);
	const subset: Record<string, Migration> = {};
	for (const m of header.migrations) subset[m.filename] = binaryMigrations[m.filename];
	await runMigrations(db, subset);

	const tables = await introspectTables(db);
	const tableMeta = new Map(tables.map((t) => [t.name, t]));

	let totalRows = 0;
	const seenTables = new Set<string>();
	await db.transaction(async (tx) => {
		progress({ phase: 'prepare', label: 'Preparing the target schema' });
		// Drop every FK so insert order (and self-references) never matter;
		// re-created verbatim below. DDL is transactional — a failed restore
		// leaves no half-loaded state.
		const fks = await tx.query<{ tbl: string; name: string; def: string }>(
			`SELECT c.conrelid::regclass::text AS tbl, c.conname AS name,
			        pg_get_constraintdef(c.oid) AS def
			 FROM pg_constraint c
			 JOIN pg_namespace n ON n.oid = c.connamespace
			 WHERE n.nspname = 'public' AND c.contype = 'f'`,
		);
		for (const fk of fks.rows) {
			await tx.exec(`ALTER TABLE ${fk.tbl} DROP CONSTRAINT ${quoteIdent(fk.name)}`);
		}

		// Migrations may seed rows (pricing catalog, defaults); the backup's
		// rows are authoritative, so clear data tables before loading.
		for (const table of tables) {
			if (table.name === '_migrations') continue;
			await tx.exec(`TRUNCATE ${quoteIdent(table.name)}`);
		}

		// The row total isn't known up front when streaming, so progress reports a
		// running count (plus compressed bytes consumed, where the source knows).
		const reportLoaded = (table: string) =>
			progress({
				phase: 'load',
				label: 'Loading rows',
				done: totalRows,
				unit: 'rows',
				bytes: consumedBytes?.(),
				detail: table,
			});
		reportLoaded('');

		// Column metadata is resolved once per table and cached, since a table's
		// rows arrive contiguously but the cache also makes a re-visit cheap.
		const columnCache = new Map<string, { colMeta: ColumnMeta[]; colList: string }>();
		const columnsFor = (tableName: string) => {
			const cached = columnCache.get(tableName);
			if (cached) return cached;
			const meta = tableMeta.get(tableName);
			if (!meta) {
				throw new RestorePreconditionError(
					`Backup contains rows for table "${tableName}", which this schema does not have.`,
				);
			}
			const backupCols = header.tables.find((t) => t.name === tableName)?.columns ?? [];
			const colMeta = backupCols.map((name) => {
				const col = meta.columns.find((c) => c.name === name);
				if (!col) {
					throw new RestorePreconditionError(
						`Backup contains column "${tableName}.${name}", which this schema does not have.`,
					);
				}
				return col;
			});
			const resolved = { colMeta, colList: colMeta.map((c) => quoteIdent(c.name)).join(', ') };
			columnCache.set(tableName, resolved);
			return resolved;
		};

		let pendingTable: string | null = null;
		let pending: Array<Record<string, unknown>> = [];
		let pendingBytes = 0;

		const flush = async () => {
			if (pendingTable === null || pending.length === 0) return;
			const { colMeta, colList } = columnsFor(pendingTable);
			const params: unknown[] = [];
			const tuples = pending.map((row) => {
				const placeholders = colMeta.map((col) => {
					params.push(decodeValue(row[col.name], col.udt));
					const cast = col.udt === 'jsonb' || col.udt === 'json' ? `::${col.udt}` : '';
					return `$${params.length}${cast}`;
				});
				return `(${placeholders.join(', ')})`;
			});
			await tx.query(
				`INSERT INTO ${quoteIdent(pendingTable)} (${colList}) VALUES ${tuples.join(', ')}`,
				params,
			);
			totalRows += pending.length;
			reportLoaded(pendingTable);
			pending = [];
			pendingBytes = 0;
		};

		for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
			const line = next.value;
			if (!line) continue;
			const { t, r } = JSON.parse(line) as { t: string; r: Record<string, unknown> };

			// A different table always closes the open batch - one INSERT never
			// spans two tables.
			if (t !== pendingTable) {
				await flush();
				pendingTable = t;
				// Validate eagerly so an unknown table fails on its first row rather
				// than after the whole stream has been read.
				columnsFor(t);
				seenTables.add(t);
			} else if (
				pending.length >= INSERT_BATCH_SIZE ||
				pendingBytes + line.length > BATCH_TARGET_BYTES
			) {
				// Same batching rule as `planInsertBatches`, applied incrementally.
				await flush();
			}

			pending.push(r);
			pendingBytes += line.length;
			if (totalRows % PARSE_PROGRESS_ROWS === 0) reportLoaded(t);
		}
		await flush();

		progress({ phase: 'constraints', label: 'Restoring foreign keys and sequences' });
		for (const fk of fks.rows) {
			await tx.exec(`ALTER TABLE ${fk.tbl} ADD CONSTRAINT ${quoteIdent(fk.name)} ${fk.def}`);
		}

		// Serial sequences resume after the highest loaded value.
		for (const table of tables) {
			for (const col of table.columns) {
				if (!col.serial) continue;
				await tx.query(
					`SELECT setval(
					   pg_get_serial_sequence($1, $2),
					   GREATEST((SELECT COALESCE(MAX(${quoteIdent(col.name)}), 0) FROM ${quoteIdent(table.name)}), 1),
					   (SELECT COUNT(*) > 0 FROM ${quoteIdent(table.name)})
					 )`,
					[table.name, col.name],
				);
			}
		}
	});

	return { tables: seenTables.size, rows: totalRows };
}
