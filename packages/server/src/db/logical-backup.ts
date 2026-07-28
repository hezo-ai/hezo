import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, gunzipSync, gzipSync } from 'node:zlib';
import { formatBytes, type ProgressCallback } from '../lib/progress';
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

/** Dump the whole database as a gzipped logical backup buffer. */
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
	db: Db,
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
 * This is the form every caller that ends up with a file on disk should use -
 * the startup pre-migration backup and the `hezo backup` CLI both do. Holding
 * the whole dump in a Buffer first (see `dumpLogicalBackup`) is what OOM-killed
 * small hosts mid-upgrade.
 */
export async function dumpLogicalBackupToFile(
	db: Db,
	filePath: string,
	meta: { hezoVersion: string; migrations: Record<string, Migration> },
): Promise<void> {
	await pipeline(
		Readable.from(streamLogicalBackupLines(db, meta), { objectMode: false }),
		createGzip(),
		createWriteStream(filePath),
	);
}

/**
 * The whole backup as one gzipped Buffer.
 *
 * Prefer `dumpLogicalBackupToFile` for anything that writes to disk: this holds
 * the entire uncompressed database in memory and is retained for callers that
 * genuinely need the bytes in hand (tests, round-trip checks).
 */
export async function dumpLogicalBackup(
	db: Db,
	meta: { hezoVersion: string; migrations: Record<string, Migration> },
): Promise<Buffer> {
	const lines: string[] = [];
	for await (const line of streamLogicalBackupLines(db, meta)) lines.push(line);
	return gzipSync(lines.join(''));
}

/**
 * Decompress a logical backup to its JSONL text; null when the bytes aren't
 * gzip at all (a legacy physical pgdata tarball, or a wrong file entirely).
 * Exposed separately from the header parse so a caller restoring a multi-GB
 * backup decompresses it once and hands the text to `restoreLogicalBackup`
 * rather than paying for a second pass.
 */
export function decompressLogicalBackup(bytes: Buffer): string | null {
	try {
		return gunzipSync(bytes).toString('utf8');
	} catch {
		return null;
	}
}

/** Parse just the header line of a decompressed backup; null if not this format. */
export function parseLogicalBackupHeader(text: string): LogicalBackupHeader | null {
	const firstLine = text.slice(0, text.indexOf('\n'));
	try {
		const header = JSON.parse(firstLine) as LogicalBackupHeader;
		return typeof header.formatVersion === 'number' && Array.isArray(header.migrations)
			? header
			: null;
	} catch {
		return null;
	}
}

/** Parse just the header from a logical backup buffer; null if not this format. */
export function readLogicalBackupHeader(bytes: Buffer): LogicalBackupHeader | null {
	const text = decompressLogicalBackup(bytes);
	return text === null ? null : parseLogicalBackupHeader(text);
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
export async function restoreLogicalBackup(
	db: Db,
	backup: Buffer | string,
	binaryMigrations: Record<string, Migration>,
	options: RestoreLogicalBackupOptions = {},
): Promise<RestoreSummary> {
	const progress: ProgressCallback = options.onProgress ?? (() => {});
	let text: string;
	if (typeof backup === 'string') {
		text = backup;
	} else {
		// gunzip is one blocking call with no observable interior, so this phase
		// is announced rather than counted.
		progress({
			phase: 'decompress',
			label: 'Decompressing the database backup',
			detail: formatBytes(backup.byteLength),
		});
		text = gunzipSync(backup).toString('utf8');
	}
	const newline = text.indexOf('\n');
	const header = JSON.parse(text.slice(0, newline)) as LogicalBackupHeader;
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

	// Group data lines by table (the file is written table-by-table), keeping
	// each row's encoded size so inserts can be batched by bytes as well as
	// row count.
	const rowsByTable = new Map<string, Array<{ row: Record<string, unknown>; bytes: number }>>();
	const body = text.slice(newline + 1);
	// The row total isn't known until the whole body is read, so completion is
	// reported as the fraction of the body consumed.
	const reportParsed = (parsed: number, consumed: number) =>
		progress({
			phase: 'parse',
			label: 'Reading rows from the backup',
			done: parsed,
			unit: 'rows',
			ratio: body.length > 0 ? consumed / body.length : 1,
		});
	let parsedRows = 0;
	let consumedChars = 0;
	reportParsed(0, 0);
	for (const line of body.split('\n')) {
		consumedChars += line.length + 1;
		if (!line) continue;
		const { t, r } = JSON.parse(line) as { t: string; r: Record<string, unknown> };
		const list = rowsByTable.get(t) ?? [];
		list.push({ row: r, bytes: line.length });
		rowsByTable.set(t, list);
		parsedRows += 1;
		if (parsedRows % PARSE_PROGRESS_ROWS === 0) reportParsed(parsedRows, consumedChars);
	}
	reportParsed(parsedRows, body.length);

	let totalRows = 0;
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

		const reportLoaded = (table: string) =>
			progress({
				phase: 'load',
				label: 'Loading rows',
				done: totalRows,
				total: parsedRows,
				unit: 'rows',
				detail: table,
			});
		reportLoaded('');

		for (const [tableName, rows] of rowsByTable) {
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
			const colList = colMeta.map((c) => quoteIdent(c.name)).join(', ');

			for (const { start, end } of planInsertBatches(rows.map((r) => r.bytes))) {
				const batch = rows.slice(start, end);
				const params: unknown[] = [];
				const tuples = batch.map(({ row }) => {
					const placeholders = colMeta.map((col) => {
						params.push(decodeValue(row[col.name], col.udt));
						const cast = col.udt === 'jsonb' || col.udt === 'json' ? `::${col.udt}` : '';
						return `$${params.length}${cast}`;
					});
					return `(${placeholders.join(', ')})`;
				});
				await tx.query(
					`INSERT INTO ${quoteIdent(tableName)} (${colList}) VALUES ${tuples.join(', ')}`,
					params,
				);
				totalRows += batch.length;
				reportLoaded(tableName);
			}
		}

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

	return { tables: rowsByTable.size, rows: totalRows };
}
