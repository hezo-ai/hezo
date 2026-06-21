import type { PGlite } from '@electric-sql/pglite';

/**
 * Deterministic, name-normalized snapshot of a Postgres schema for equivalence
 * checks. Two databases that produce byte-identical output from `introspectSchema`
 * have the same tables, columns, enums, indexes, constraints, functions and
 * triggers — regardless of the order the DDL ran in or physical column ordering.
 *
 * This is the gate for the v1.0 migration collapse: the schema produced by the
 * single `001_initial_schema.sql` baseline must match the schema the historical
 * `001`–`016` chain produced (captured once into a committed fixture). It also
 * guards the frozen baseline against accidental drift thereafter.
 *
 * Runner bookkeeping (`_migrations`) and the pre-v1 upgrade-path placeholder
 * (`migration_smoke`, created by the old `002` and intentionally dropped in the
 * collapse) are excluded so the comparison reflects the real application schema.
 */
const EXCLUDED_TABLES = ['_migrations', 'migration_smoke'];

function excludedList(): string {
	return EXCLUDED_TABLES.map((t) => `'${t}'`).join(', ');
}

export async function introspectSchema(db: PGlite): Promise<string> {
	const sections: string[] = [];

	// 1. Tables (base tables only).
	const tables = await db.query<{ table_name: string }>(
		`SELECT table_name FROM information_schema.tables
		 WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
		   AND table_name NOT IN (${excludedList()})
		 ORDER BY table_name`,
	);
	sections.push(`== TABLES ==\n${tables.rows.map((r) => r.table_name).join('\n')}`);

	// 2. Columns — ordered by name so physical column order is normalized away.
	const cols = await db.query<{
		table_name: string;
		column_name: string;
		data_type: string;
		udt_name: string;
		is_nullable: string;
		column_default: string;
	}>(
		`SELECT table_name, column_name, data_type, udt_name, is_nullable,
		        COALESCE(column_default, '') AS column_default
		 FROM information_schema.columns
		 WHERE table_schema = 'public' AND table_name NOT IN (${excludedList()})
		 ORDER BY table_name, column_name`,
	);
	sections.push(
		`== COLUMNS ==\n${cols.rows
			.map(
				(r) =>
					`${r.table_name}.${r.column_name} | ${r.data_type} | ${r.udt_name} | nullable=${r.is_nullable} | default=${r.column_default}`,
			)
			.join('\n')}`,
	);

	// 3. Enums — labels in sort order.
	const enums = await db.query<{ typname: string; enumlabel: string }>(
		`SELECT t.typname, e.enumlabel
		 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
		 ORDER BY t.typname, e.enumsortorder`,
	);
	const enumMap = new Map<string, string[]>();
	for (const row of enums.rows) {
		const list = enumMap.get(row.typname) ?? [];
		list.push(row.enumlabel);
		enumMap.set(row.typname, list);
	}
	sections.push(
		`== ENUMS ==\n${[...enumMap.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, labels]) => `${name}: ${labels.join(', ')}`)
			.join('\n')}`,
	);

	// 4. Indexes — full indexdef (name included; we keep index names stable).
	const indexes = await db.query<{ indexdef: string }>(
		`SELECT indexdef FROM pg_indexes
		 WHERE schemaname = 'public' AND tablename NOT IN (${excludedList()})
		 ORDER BY indexname`,
	);
	sections.push(`== INDEXES ==\n${indexes.rows.map((r) => r.indexdef).join('\n')}`);

	// 5. Constraints — by definition, so auto-generated names don't cause noise.
	const constraints = await db.query<{ tbl: string; contype: string; def: string }>(
		`SELECT c.conrelid::regclass::text AS tbl, c.contype::text AS contype,
		        pg_get_constraintdef(c.oid) AS def
		 FROM pg_constraint c
		 JOIN pg_class cl ON cl.oid = c.conrelid
		 JOIN pg_namespace n ON n.oid = cl.relnamespace
		 WHERE n.nspname = 'public' AND cl.relname NOT IN (${excludedList()})
		 ORDER BY tbl, contype, def`,
	);
	sections.push(
		`== CONSTRAINTS ==\n${constraints.rows
			.map((r) => `${r.tbl} | ${r.contype} | ${r.def}`)
			.join('\n')}`,
	);

	// 6. Functions — full definition. Restrict to our own normal functions:
	// exclude aggregates/window/procedures (prokind <> 'f') and anything owned by
	// an extension (e.g. pgvector's ops), which are identical across both DBs and
	// which pg_get_functiondef rejects (it errors on aggregate functions).
	const fns = await db.query<{ proname: string; def: string }>(
		`SELECT p.proname, pg_get_functiondef(p.oid) AS def
		 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
		 WHERE n.nspname = 'public' AND p.prokind = 'f'
		   AND NOT EXISTS (
		     SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e'
		   )
		 ORDER BY p.proname, def`,
	);
	sections.push(
		`== FUNCTIONS ==\n${fns.rows.map((r) => `--- ${r.proname} ---\n${r.def}`).join('\n')}`,
	);

	// 7. Triggers — non-internal only, full definition.
	const triggers = await db.query<{ tbl: string; tgname: string; def: string }>(
		`SELECT t.tgrelid::regclass::text AS tbl, t.tgname, pg_get_triggerdef(t.oid) AS def
		 FROM pg_trigger t
		 JOIN pg_class cl ON cl.oid = t.tgrelid
		 JOIN pg_namespace n ON n.oid = cl.relnamespace
		 WHERE NOT t.tgisinternal AND n.nspname = 'public'
		   AND cl.relname NOT IN (${excludedList()})
		 ORDER BY tbl, t.tgname`,
	);
	sections.push(`== TRIGGERS ==\n${triggers.rows.map((r) => r.def).join('\n')}`);

	return `${sections.join('\n\n')}\n`;
}
