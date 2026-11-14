import { describe, expect, it } from 'vitest';
import { computeLineDiff, DIFF_CONTEXT_LINES, foldUnchanged } from '../src/lib/line-diff';

const lines = (n: number, prefix = 'line') =>
	Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);

describe('computeLineDiff', () => {
	it('numbers each line on the side it exists on, and counts both sides', () => {
		const diff = computeLineDiff('a\nb\nc', 'a\nB\nc\nd');
		expect(diff.added).toBe(2);
		expect(diff.removed).toBe(1);
		expect(diff.lines).toEqual([
			{ kind: 'context', oldNo: 1, newNo: 1, text: 'a' },
			{ kind: 'removed', oldNo: 2, newNo: null, text: 'b' },
			{ kind: 'added', oldNo: null, newNo: 2, text: 'B' },
			{ kind: 'context', oldNo: 3, newNo: 3, text: 'c' },
			{ kind: 'added', oldNo: null, newNo: 4, text: 'd' },
		]);
	});

	it('reports no change for identical texts', () => {
		const diff = computeLineDiff('a\nb', 'a\nb');
		expect(diff.added + diff.removed).toBe(0);
	});
});

describe('foldUnchanged', () => {
	it('keeps context beside a change and folds the rest of a long run', () => {
		const before = [...lines(20), 'old'].join('\n');
		const after = [...lines(20), 'new'].join('\n');
		const items = foldUnchanged(computeLineDiff(before, after).lines);
		// A run at the start has no change before it, so only the side next to the
		// change keeps context.
		expect(items[0]).toMatchObject({ kind: 'fold' });
		expect((items[0] as { lines: unknown[] }).lines).toHaveLength(20 - DIFF_CONTEXT_LINES);
		expect(items.slice(1, 1 + DIFF_CONTEXT_LINES).every((i) => i.kind === 'context')).toBe(true);
	});

	it('shows a short run whole rather than folding a few lines', () => {
		const before = ['x', ...lines(5), 'y'].join('\n');
		const after = ['X', ...lines(5), 'Y'].join('\n');
		const items = foldUnchanged(computeLineDiff(before, after).lines);
		expect(items.some((i) => i.kind === 'fold')).toBe(false);
	});
});
