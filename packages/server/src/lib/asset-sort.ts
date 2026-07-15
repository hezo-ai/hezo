import { AssetSortOrder } from '@hezo/shared';

/**
 * SQL `ORDER BY` body for the assets list, mirroring `compareAssetsForSort`
 * from `@hezo/shared` (the single source of truth the web client sort also
 * uses). `prefix` is the table-alias qualifier — `'a.'` for the REST route's
 * `assets a`, `''` for the MCP tool's unaliased query. `order` must already be
 * a validated `AssetSortOrder`, so the returned fragment never carries user
 * input.
 */
export function assetSortOrderBy(order: AssetSortOrder, prefix = ''): string {
	const created = `${prefix}created_at`;
	const name = `LOWER(${prefix}original_filename)`;
	switch (order) {
		case AssetSortOrder.Oldest:
			return `${created} ASC, ${name} ASC`;
		case AssetSortOrder.Alphabetical:
			return `${name} ASC, ${created} DESC`;
		default:
			return `${created} DESC, ${name} ASC`;
	}
}
