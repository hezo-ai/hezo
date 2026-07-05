import { gunzipSync, gzipSync } from 'node:zlib';
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
export async function dumpLogicalBackup(
	db: Db,
	meta: { hezoVersion: string; migrations: Record<string, Migration> },
): Promise<Buffer> {
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

	const lines: string[] = [JSON.stringify(header)];
	for (const table of tables) {
		if (table.name === '_migrations') continue;
		const cols = table.columns.filter((c) => !c.generated);
		const colList = cols.map((c) => quoteIdent(c.name)).join(', ');
		const orderBy =
			table.pk.length > 0 ? `ORDER BY ${table.pk.map((c) => quoteIdent(c)).join(', ')}` : '';

		let offset = 0;
		for (;;) {
			// Keyset pagination would be nicer, but OFFSET paging with a stable
			// PK order is correct and Hezo-scale tables are modest. Tables with
			// no PK are read in one page.
			const page = await db.query<Record<string, unknown>>(
				orderBy
					? `SELECT ${colList} FROM ${quoteIdent(table.name)} ${orderBy} LIMIT ${DUMP_PAGE_SIZE} OFFSET ${offset}`
					: `SELECT ${colList} FROM ${quoteIdent(table.name)}`,
			);
			for (const row of page.rows) {
				const encoded: Record<string, unknown> = {};
				for (const col of cols) {
					encoded[col.name] = encodeValue(row[col.name], col.udt);
				}
				lines.push(JSON.stringify({ t: table.name, r: encoded }));
			}
			if (!orderBy || page.rows.length < DUMP_PAGE_SIZE) break;
			offset += DUMP_PAGE_SIZE;
		}
	}

	return gzipSync(`${lines.join('\n')}\n`);
}

/** Parse just the header from a logical backup buffer; null if not this format. */
export function readLogicalBackupHeader(bytes: Buffer): LogicalBackupHeader | null {
	let text: string;
	try {
		text = gunzipSync(bytes).toString('utf8');
	} catch {
		return null;
	}
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

/**
 * Restore a logical backup into `db`. The target must be empty (no tables in
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
	bytes: Buffer,
	binaryMigrations: Record<string, Migration>,
	options: { wipe?: boolean } = {},
): Promise<RestoreSummary> {
	const text = gunzipSync(bytes).toString('utf8');
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
		await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
	}

	// Reproduce the schema at exactly the backup's migration set.
	await db.exec(BASE_SCHEMA);
	const subset: Record<string, Migration> = {};
	for (const m of header.migrations) subset[m.filename] = binaryMigrations[m.filename];
	await runMigrations(db, subset);

	const tables = await introspectTables(db);
	const tableMeta = new Map(tables.map((t) => [t.name, t]));

	// Group data lines by table (the file is written table-by-table).
	const rowsByTable = new Map<string, Record<string, unknown>[]>();
	for (const line of text.slice(newline + 1).split('\n')) {
		if (!line) continue;
		const { t, r } = JSON.parse(line) as { t: string; r: Record<string, unknown> };
		const list = rowsByTable.get(t) ?? [];
		list.push(r);
		rowsByTable.set(t, list);
	}

	let totalRows = 0;
	await db.transaction(async (tx) => {
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

			for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
				const batch = rows.slice(i, i + INSERT_BATCH_SIZE);
				const params: unknown[] = [];
				const tuples = batch.map((row) => {
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
			}
		}

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
