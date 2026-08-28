import { AssetSortOrder } from '@hezo/shared';

/**
 * SQL for the list view's Type column, mirroring `assetTypeLabel` from
 * `@hezo/shared`: the filename's extension upper-cased, or `FILE` when it has
 * none. `original_filename` is a column, so the pattern is a literal and the
 * fragment carries no user input.
 */
function assetTypeSortSql(prefix: string): string {
	return `UPPER(COALESCE(SUBSTRING(${prefix}original_filename FROM '\\.([^./]+)$'), 'FILE'))`;
}

/**
 * SQL `ORDER BY` body for the assets list, mirroring `compareAssetsForSort`
 * from `@hezo/shared` (the single source of truth the web client sort also
 * uses). `prefix` is the table-alias qualifier — `'a.'` for the REST route's
 * `assets a`, `''` for the MCP tool's unaliased query. `order` must already be
 * a validated `AssetSortOrder`, so the returned fragment never carries user
 * input.
 *
 * Every order in the enum has a case here: an unhandled one would silently
 * serve a different order than the client sorted by, so `assetSortOrderBy` is
 * exhaustive and a test compares its output against the comparator row for row.
 */
export function assetSortOrderBy(order: AssetSortOrder, prefix = ''): string {
	const created = `${prefix}created_at`;
	const name = `LOWER(${prefix}original_filename)`;
	const size = `${prefix}byte_size`;
	const type = assetTypeSortSql(prefix);
	switch (order) {
		case AssetSortOrder.Oldest:
			return `${created} ASC, ${name} ASC`;
		case AssetSortOrder.Alphabetical:
			return `${name} ASC, ${created} DESC`;
		case AssetSortOrder.AlphabeticalDesc:
			return `${name} DESC, ${created} DESC`;
		case AssetSortOrder.SizeAsc:
			return `${size} ASC, ${name} ASC`;
		case AssetSortOrder.SizeDesc:
			return `${size} DESC, ${name} ASC`;
		case AssetSortOrder.TypeAsc:
			return `${type} ASC, ${name} ASC`;
		case AssetSortOrder.TypeDesc:
			return `${type} DESC, ${name} ASC`;
		default:
			return `${created} DESC, ${name} ASC`;
	}
}
