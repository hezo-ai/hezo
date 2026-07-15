import { describe, expect, it } from 'vitest';
import {
	type AssetSortFields,
	AssetSortOrder,
	compareAssetsForSort,
	isAssetSortOrder,
} from '../src/types/common';

const asset = (created_at: string, original_filename: string): AssetSortFields => ({
	created_at,
	original_filename,
});

/** Sort a copy of the list with the comparator and return the filenames. */
function order(list: AssetSortFields[], sort: AssetSortOrder): string[] {
	return [...list].sort((a, b) => compareAssetsForSort(a, b, sort)).map((a) => a.original_filename);
}

describe('isAssetSortOrder', () => {
	it('accepts the three known orders', () => {
		expect(isAssetSortOrder('newest')).toBe(true);
		expect(isAssetSortOrder('oldest')).toBe(true);
		expect(isAssetSortOrder('alphabetical')).toBe(true);
	});

	it('rejects unknown / malformed values', () => {
		expect(isAssetSortOrder('name')).toBe(false);
		expect(isAssetSortOrder('')).toBe(false);
		expect(isAssetSortOrder(undefined)).toBe(false);
		expect(isAssetSortOrder(null)).toBe(false);
		expect(isAssetSortOrder(1)).toBe(false);
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
		// Sanity: distinct paths still order by path.
		expect(order(dupes, AssetSortOrder.Alphabetical)).toEqual([
			'launch/hero.png',
			'promo/hero.png',
		]);
	});
});
