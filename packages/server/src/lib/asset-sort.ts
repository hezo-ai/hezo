import { AssetSortOrder } from '@hezo/shared';
import { decodeCursor } from './pagination';

/**
 * SQL for the list view's Type column, mirroring `assetTypeLabel` from
 * `@hezo/shared`: the filename's extension upper-cased, or `FILE` when it has
 * none. `original_filename` is a column, so the pattern is a literal and the
 * fragment carries no user input.
 */
function assetTypeSortSql(prefix: string): string {
	return `UPPER(COALESCE(SUBSTRING(${prefix}original_filename FROM '\\.([^./]+)$'), 'FILE'))`;
}

/** One key of an asset sort order: the SQL it orders by, its direction, and its type. */
interface AssetSortKey {
	expr: string;
	dir: 'ASC' | 'DESC';
	/** The type a cursor's text value is cast back to when compared. */
	cast: 'timestamptz' | 'text' | 'bigint';
}

/**
 * Each sort order's keys, mirroring `compareAssetsForSort` from `@hezo/shared`
 * (the single source of truth the web client sort also uses). The `ORDER BY`
 * and the list tool's keyset both read this table, so the two can never order
 * differently. `prefix` is the table-alias qualifier: `'a.'` for the REST
 * route's `assets a`, `''` for the MCP tool's unaliased query. `order` must
 * already be a validated `AssetSortOrder`, so no fragment carries user input.
 *
 * The record is keyed by every order in the enum, so an unhandled one is a
 * compile error, and a test compares the resulting order against the
 * comparator row for row.
 */
function assetSortKeys(order: AssetSortOrder, prefix = ''): AssetSortKey[] {
	const created = { expr: `${prefix}created_at`, cast: 'timestamptz' } as const;
	const name = { expr: `LOWER(${prefix}original_filename)`, cast: 'text' } as const;
	const size = { expr: `${prefix}byte_size`, cast: 'bigint' } as const;
	const type = { expr: assetTypeSortSql(prefix), cast: 'text' } as const;
	const keys: Record<AssetSortOrder, AssetSortKey[]> = {
		[AssetSortOrder.Newest]: [
			{ ...created, dir: 'DESC' },
			{ ...name, dir: 'ASC' },
		],
		[AssetSortOrder.Oldest]: [
			{ ...created, dir: 'ASC' },
			{ ...name, dir: 'ASC' },
		],
		[AssetSortOrder.Alphabetical]: [
			{ ...name, dir: 'ASC' },
			{ ...created, dir: 'DESC' },
		],
		[AssetSortOrder.AlphabeticalDesc]: [
			{ ...name, dir: 'DESC' },
			{ ...created, dir: 'DESC' },
		],
		[AssetSortOrder.SizeAsc]: [
			{ ...size, dir: 'ASC' },
			{ ...name, dir: 'ASC' },
		],
		[AssetSortOrder.SizeDesc]: [
			{ ...size, dir: 'DESC' },
			{ ...name, dir: 'ASC' },
		],
		[AssetSortOrder.TypeAsc]: [
			{ ...type, dir: 'ASC' },
			{ ...name, dir: 'ASC' },
		],
		[AssetSortOrder.TypeDesc]: [
			{ ...type, dir: 'DESC' },
			{ ...name, dir: 'ASC' },
		],
	};
	return keys[order] ?? keys[AssetSortOrder.Newest];
}

/** SQL `ORDER BY` body for the assets list, in the given sort order. */
export function assetSortOrderBy(order: AssetSortOrder, prefix = ''): string {
	return assetSortKeys(order, prefix)
		.map((k) => `${k.expr} ${k.dir}`)
		.join(', ');
}

/**
 * The select-list fragment carrying a row's sort keys as text, `sort_key_0` and
 * on, for a keyset cursor. Text rather than the typed value because a timestamp
 * read back into JavaScript loses its microseconds, and a cursor built from the
 * rounded value would skip or repeat rows.
 */
export function assetSortKeySelect(order: AssetSortOrder, prefix = ''): string {
	return assetSortKeys(order, prefix)
		.map((k, i) => `(${k.expr})::text AS sort_key_${i}`)
		.join(', ');
}

/** A row's sort keys, as `assetSortKeySelect` selected them. */
export function assetSortKeyValues(row: Record<string, unknown>, order: AssetSortOrder): string[] {
	return assetSortKeys(order).map((_, i) => String(row[`sort_key_${i}`] ?? ''));
}

/**
 * SQL for "after this row" in an asset sort order, with `id` as the last,
 * ascending tie-break the query must also order by. The keys may run in mixed
 * directions, so this is the expanded form - each key strictly past its value
 * with every earlier key equal - rather than a row comparison, which only
 * holds when every key runs the same way. Pushes its bind params onto `params`.
 */
export function assetKeysetPredicate(
	order: AssetSortOrder,
	cursor: { values: string[]; id: string },
	params: unknown[],
	prefix = '',
): string {
	const keys = assetSortKeys(order, prefix);
	const bound = keys.map((k, i) => `$${params.push(cursor.values[i] ?? '')}::${k.cast}`);
	const idParam = `$${params.push(cursor.id)}::uuid`;
	const equalThrough = (n: number) => keys.slice(0, n).map((k, i) => `${k.expr} = ${bound[i]}`);
	const arms = keys.map((k, i) =>
		[...equalThrough(i), `${k.expr} ${k.dir === 'ASC' ? '>' : '<'} ${bound[i]}`].join(' AND '),
	);
	arms.push([...equalThrough(keys.length), `${prefix}id > ${idParam}`].join(' AND '));
	return `(${arms.map((a) => `(${a})`).join(' OR ')})`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An asset list cursor, as the list tool encodes it: the row's sort keys as a
 * JSON array of text, and its id. Null for no cursor or a malformed one, which
 * reads as the first page, the way every list cursor here does.
 */
export function decodeAssetCursor(
	raw: string | undefined,
): { values: string[]; id: string } | null {
	const cursor = decodeCursor(raw);
	if (!cursor || !UUID_RE.test(cursor.id)) return null;
	try {
		const values: unknown = JSON.parse(cursor.value);
		if (Array.isArray(values) && values.every((v) => typeof v === 'string')) {
			return { values, id: cursor.id };
		}
	} catch {
		// Not a cursor this tool wrote.
	}
	return null;
}
