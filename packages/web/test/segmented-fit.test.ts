import { describe, expect, it } from 'vitest';
import { SEGMENTED_FIT_TOLERANCE_PX, segmentedLabelsFit } from '../src/lib/segmented-fit';

describe('segmentedLabelsFit', () => {
	it('fits when the labels leave room for the tolerance', () => {
		expect(segmentedLabelsFit(200, 208 + SEGMENTED_FIT_TOLERANCE_PX)).toBe(true);
		expect(segmentedLabelsFit(100, 328)).toBe(true);
	});

	it('does not fit when the labels only just reach the edge', () => {
		// Exactly the available width: no room for the divider gap.
		expect(segmentedLabelsFit(208, 208)).toBe(false);
		expect(segmentedLabelsFit(208, 208 + SEGMENTED_FIT_TOLERANCE_PX - 1)).toBe(false);
	});

	it('fits at exactly the tolerance', () => {
		expect(segmentedLabelsFit(208, 208 + SEGMENTED_FIT_TOLERANCE_PX)).toBe(true);
	});

	it('does not fit when the labels overflow', () => {
		// The German case: longer words in the same rail.
		expect(segmentedLabelsFit(260, 208)).toBe(false);
	});

	it('shows labels when the width cannot be measured', () => {
		// happy-dom reports 0 for every box; an unmeasured control must not
		// collapse to icons on the strength of a number it never had.
		expect(segmentedLabelsFit(0, 0)).toBe(true);
		expect(segmentedLabelsFit(120, 0)).toBe(true);
		expect(segmentedLabelsFit(0, 300)).toBe(true);
		expect(segmentedLabelsFit(Number.NaN, 300)).toBe(true);
		expect(segmentedLabelsFit(120, Number.POSITIVE_INFINITY)).toBe(true);
	});
});
