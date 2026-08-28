import { describe, expect, it } from 'vitest';
import {
	ASSET_SORT_FIELDS,
	type AssetSortFields,
	AssetSortOrder,
	assetSortDirection,
	assetSortField,
	assetSortOrderFor,
	assetTypeLabel,
	compareAssetsForSort,
	isAssetSortOrder,
} from '../src/types/common';

const asset = (
	created_at: string,
	original_filename: string,
	byte_size = 100,
): AssetSortFields => ({
	created_at,
	original_filename,
	byte_size,
});

/** Sort a copy of the list with the comparator and return the filenames. */
function order(list: AssetSortFields[], sort: AssetSortOrder): string[] {
	return [...list].sort((a, b) => compareAssetsForSort(a, b, sort)).map((a) => a.original_filename);
}

describe('isAssetSortOrder', () => {
	it('accepts every known order', () => {
		for (const value of Object.values(AssetSortOrder)) {
			expect(isAssetSortOrder(value), value).toBe(true);
		}
	});

	it('rejects unknown / malformed values', () => {
		expect(isAssetSortOrder('name')).toBe(false);
		expect(isAssetSortOrder('size')).toBe(false);
		expect(isAssetSortOrder('')).toBe(false);
		expect(isAssetSortOrder(undefined)).toBe(false);
		expect(isAssetSortOrder(null)).toBe(false);
		expect(isAssetSortOrder(1)).toBe(false);
	});
});

describe('ASSET_SORT_FIELDS', () => {
	// The list view's headers and the sort popover both turn a column into an
	// order through this table. An order missing from it would be unreachable
	// from either, and `assetSortField` would quietly report it as Modified.
	it('covers every order exactly once', () => {
		const seen = Object.values(ASSET_SORT_FIELDS).flatMap((pair) => [pair.asc, pair.desc]);
		expect([...seen].sort()).toEqual([...Object.values(AssetSortOrder)].sort());
	});

	it('round-trips an order through its field and direction', () => {
		for (const value of Object.values(AssetSortOrder)) {
			expect(assetSortOrderFor(assetSortField(value), assetSortDirection(value))).toBe(value);
		}
	});

	it('opens the two quantitative columns at their useful end', () => {
		// Nobody clicking Size wants the smallest file first.
		expect(ASSET_SORT_FIELDS.size.first).toBe('desc');
		expect(ASSET_SORT_FIELDS.modified.first).toBe('desc');
		expect(ASSET_SORT_FIELDS.name.first).toBe('asc');
		expect(ASSET_SORT_FIELDS.type.first).toBe('asc');
	});
});

describe('assetTypeLabel', () => {
	it('reads the extension, upper-cased', () => {
		expect(assetTypeLabel('report.csv')).toBe('CSV');
		expect(assetTypeLabel('launch/hero.PNG')).toBe('PNG');
		expect(assetTypeLabel('notes.md')).toBe('MD');
	});

	it('takes the last extension of a double-extension name', () => {
		expect(assetTypeLabel('bundle.tar.gz')).toBe('GZ');
	});

	it('falls back for a name with no extension', () => {
		expect(assetTypeLabel('README')).toBe('FILE');
		// A dot in a folder segment is not the file's extension.
		expect(assetTypeLabel('v1.2/README')).toBe('FILE');
	});

	it('treats a leading dot as an extension, as a file manager does', () => {
		expect(assetTypeLabel('.gitignore')).toBe('GITIGNORE');
	});
});

describe('compareAssetsForSort', () => {
	const list = [
		asset('2026-01-03T00:00:00Z', 'banana.png'),
		asset('2026-01-01T00:00:00Z', 'cherry.png'),
		asset('2026-01-02T00:00:00Z', 'apple.png'),
	];

	it('Newest orders by created_at descending', () => {
		expect(order(list, AssetSortOrder.Newest)).toEqual(['banana.png', 'apple.png', 'cherry.png']);
	});

	it('Oldest orders by created_at ascending', () => {
		expect(order(list, AssetSortOrder.Oldest)).toEqual(['cherry.png', 'apple.png', 'banana.png']);
	});

	it('Alphabetical orders by filename A→Z, case-insensitively', () => {
		const mixed = [
			asset('2026-01-01T00:00:00Z', 'Zebra.png'),
			asset('2026-01-01T00:00:00Z', 'apple.png'),
			asset('2026-01-01T00:00:00Z', 'Banana.png'),
		];
		expect(order(mixed, AssetSortOrder.Alphabetical)).toEqual([
			'apple.png',
			'Banana.png',
			'Zebra.png',
		]);
		expect(order(mixed, AssetSortOrder.AlphabeticalDesc)).toEqual([
			'Zebra.png',
			'Banana.png',
			'apple.png',
		]);
	});

	it('orders by byte size in both directions', () => {
		const sizes = [
			asset('2026-01-01T00:00:00Z', 'medium.png', 5_000),
			asset('2026-01-01T00:00:00Z', 'small.png', 12),
			asset('2026-01-01T00:00:00Z', 'large.png', 1_048_576),
		];
		expect(order(sizes, AssetSortOrder.SizeAsc)).toEqual(['small.png', 'medium.png', 'large.png']);
		expect(order(sizes, AssetSortOrder.SizeDesc)).toEqual(['large.png', 'medium.png', 'small.png']);
	});

	it('orders by the type token, grouping same-extension files together', () => {
		const types = [
			asset('2026-01-01T00:00:00Z', 'shot.png'),
			asset('2026-01-01T00:00:00Z', 'rows.csv'),
			asset('2026-01-01T00:00:00Z', 'notes.md'),
			asset('2026-01-01T00:00:00Z', 'more-rows.csv'),
		];
		expect(order(types, AssetSortOrder.TypeAsc)).toEqual([
			'more-rows.csv',
			'rows.csv',
			'notes.md',
			'shot.png',
		]);
		expect(order(types, AssetSortOrder.TypeDesc)).toEqual([
			'shot.png',
			'notes.md',
			'more-rows.csv',
			'rows.csv',
		]);
	});

	it('breaks date ties by filename ascending (Newest/Oldest)', () => {
		const sameDay = [
			asset('2026-01-01T00:00:00Z', 'gamma.png'),
			asset('2026-01-01T00:00:00Z', 'alpha.png'),
			asset('2026-01-01T00:00:00Z', 'beta.png'),
		];
		expect(order(sameDay, AssetSortOrder.Newest)).toEqual(['alpha.png', 'beta.png', 'gamma.png']);
		expect(order(sameDay, AssetSortOrder.Oldest)).toEqual(['alpha.png', 'beta.png', 'gamma.png']);
	});

	it('breaks size and type ties by filename ascending, in both directions', () => {
		const tied = [
			asset('2026-01-01T00:00:00Z', 'gamma.csv', 40),
			asset('2026-01-01T00:00:00Z', 'alpha.csv', 40),
		];
		for (const sort of [
			AssetSortOrder.SizeAsc,
			AssetSortOrder.SizeDesc,
			AssetSortOrder.TypeAsc,
			AssetSortOrder.TypeDesc,
		]) {
			expect(order(tied, sort), sort).toEqual(['alpha.csv', 'gamma.csv']);
		}
	});

	it('breaks name ties by created_at descending (Alphabetical)', () => {
		// Same basename in two folders keeps the newer copy first.
		const dupes = [
			asset('2026-01-01T00:00:00Z', 'launch/hero.png'),
			asset('2026-01-05T00:00:00Z', 'promo/hero.png'),
		];
		// Different full paths sort by path; identical paths can't occur (unique),
		// so exercise the tiebreak with equal names via a direct comparison.
		const older = asset('2026-01-01T00:00:00Z', 'hero.png');
		const newer = asset('2026-01-05T00:00:00Z', 'hero.png');
		expect(compareAssetsForSort(newer, older, AssetSortOrder.Alphabetical)).toBeLessThan(0);
		expect(compareAssetsForSort(older, newer, AssetSortOrder.Alphabetical)).toBeGreaterThan(0);
		expect(compareAssetsForSort(newer, older, AssetSortOrder.AlphabeticalDesc)).toBeLessThan(0);
		// Sanity: distinct paths still order by path.
		expect(order(dupes, AssetSortOrder.Alphabetical)).toEqual([
			'launch/hero.png',
			'promo/hero.png',
		]);
	});

	it('is a total order for every sort - no pair ever ties', () => {
		// A comparator returning 0 for two distinct rows makes the list order
		// depend on the engine's sort stability, which the SQL mirror does not
		// share. Every branch must fall through to a unique tiebreak.
		const rows = [
			asset('2026-01-01T00:00:00Z', 'a.csv', 10),
			asset('2026-01-01T00:00:00Z', 'b.csv', 10),
			asset('2026-01-01T00:00:00Z', 'c.md', 10),
		];
		for (const sort of Object.values(AssetSortOrder)) {
			for (const a of rows) {
				for (const b of rows) {
					if (a === b) continue;
					expect(compareAssetsForSort(a, b, sort), `${sort} ${a.original_filename}`).not.toBe(0);
				}
			}
		}
	});
});
