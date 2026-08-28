/**
 * How the assets library lays its contents out. A view concern the URL carries
 * (`?view=list`), like the archive filter and the sort order beside it — the
 * API returns the same rows either way, so this never leaves the web.
 */
export const AssetView = {
	Grid: 'grid',
	List: 'list',
} as const;
export type AssetView = (typeof AssetView)[keyof typeof AssetView];

export function isAssetView(value: unknown): value is AssetView {
	return typeof value === 'string' && (Object.values(AssetView) as string[]).includes(value);
}
