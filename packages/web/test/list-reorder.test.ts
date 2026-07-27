import { describe, expect, test } from 'vitest';
import { moveItem, shiftForIndex, targetIndexForOffset } from '../src/lib/list-reorder';

const ITEMS = ['a', 'b', 'c', 'd'];

describe('moveItem', () => {
	test('moves an item down, shifting the ones it passes up', () => {
		expect(moveItem(ITEMS, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
	});

	test('moves an item up, shifting the ones it passes down', () => {
		expect(moveItem(ITEMS, 3, 1)).toEqual(['a', 'd', 'b', 'c']);
	});

	test('moving to the same index returns the original array untouched', () => {
		expect(moveItem(ITEMS, 2, 2)).toBe(ITEMS);
	});

	test('does not mutate the input', () => {
		const original = [...ITEMS];
		moveItem(ITEMS, 0, 3);
		expect(ITEMS).toEqual(original);
	});

	test('handles the ends', () => {
		expect(moveItem(ITEMS, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
		expect(moveItem(ITEMS, 0, 3)).toEqual(['b', 'c', 'd', 'a']);
	});

	test('out-of-range indices are a no-op', () => {
		expect(moveItem(ITEMS, -1, 2)).toBe(ITEMS);
		expect(moveItem(ITEMS, 1, 9)).toBe(ITEMS);
		expect(moveItem([], 0, 0)).toEqual([]);
	});
});

describe('targetIndexForOffset', () => {
	const PITCH = 44;

	test('stays put below half a pitch of travel', () => {
		expect(targetIndexForOffset(1, 0, PITCH, 4)).toBe(1);
		expect(targetIndexForOffset(1, 21, PITCH, 4)).toBe(1);
		expect(targetIndexForOffset(1, -21, PITCH, 4)).toBe(1);
	});

	test('advances one slot once past half a pitch', () => {
		expect(targetIndexForOffset(1, 23, PITCH, 4)).toBe(2);
		expect(targetIndexForOffset(1, -23, PITCH, 4)).toBe(0);
	});

	test('advances multiple slots on longer travel', () => {
		expect(targetIndexForOffset(0, PITCH * 2, PITCH, 4)).toBe(2);
		expect(targetIndexForOffset(3, -PITCH * 3, PITCH, 4)).toBe(0);
	});

	test('clamps at both ends of the list', () => {
		expect(targetIndexForOffset(3, PITCH * 10, PITCH, 4)).toBe(3);
		expect(targetIndexForOffset(0, -PITCH * 10, PITCH, 4)).toBe(0);
	});

	test('degenerate pitch or count cannot produce an out-of-range index', () => {
		expect(targetIndexForOffset(2, 500, 0, 4)).toBe(2);
		expect(targetIndexForOffset(9, 500, PITCH, 4)).toBe(3);
		expect(targetIndexForOffset(0, 500, PITCH, 0)).toBe(0);
	});
});

describe('shiftForIndex', () => {
	const PITCH = 44;

	test('the dragged item itself never gets a shift', () => {
		expect(shiftForIndex(1, 1, 3, PITCH)).toBe(0);
	});

	test('dragging down moves the passed items up by one pitch', () => {
		// 0 -> 2: items 1 and 2 slide up, item 3 is untouched.
		expect(shiftForIndex(1, 0, 2, PITCH)).toBe(-PITCH);
		expect(shiftForIndex(2, 0, 2, PITCH)).toBe(-PITCH);
		expect(shiftForIndex(3, 0, 2, PITCH)).toBe(0);
	});

	test('dragging up moves the passed items down by one pitch', () => {
		// 3 -> 1: items 1 and 2 slide down, item 0 is untouched.
		expect(shiftForIndex(1, 3, 1, PITCH)).toBe(PITCH);
		expect(shiftForIndex(2, 3, 1, PITCH)).toBe(PITCH);
		expect(shiftForIndex(0, 3, 1, PITCH)).toBe(0);
	});

	test('no shift at all when the drag has not changed slots', () => {
		for (let i = 0; i < 4; i++) expect(shiftForIndex(i, 2, 2, PITCH)).toBe(0);
	});

	test('the shifts describe exactly the ordering moveItem produces', () => {
		// Every non-dragged item that moves must end up in a different slot, and
		// the count of shifted items must match the distance travelled.
		const from = 0;
		const to = 2;
		const shifted = ITEMS.filter((_, i) => shiftForIndex(i, from, to, PITCH) !== 0);
		expect(shifted).toEqual(['b', 'c']);
		expect(moveItem(ITEMS, from, to)).toEqual(['b', 'c', 'a', 'd']);
	});
});
