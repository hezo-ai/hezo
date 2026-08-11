// Unit tests for the dropdown-panel placement math: which side of the anchor a
// panel opens on, and the height cap that keeps it inside its band. This is the
// tier that can actually assert the geometry — happy-dom has no layout, so the
// hook and component tiers only see zero-sized rects. Real pixels are covered by
// test/browser/dropdown-flip-placement.mobile.spec.ts.
import { describe, expect, test } from 'vitest';
import {
	PANEL_EDGE_PADDING_PX,
	PANEL_MIN_HEIGHT_PX,
	PANEL_SIDE_CLASS,
	type PanelPlacementInput,
	resolvePanelPlacement,
} from '../src/lib/panel-placement';

/** A tall band with the anchor near its top — the "plenty of room below" base case. */
function base(overrides: Partial<PanelPlacementInput> = {}): PanelPlacementInput {
	return {
		anchorTop: 100,
		anchorBottom: 140,
		viewportTop: 0,
		viewportBottom: 800,
		contentHeight: 300,
		preferredMaxHeight: 256,
		...overrides,
	};
}

describe('side selection', () => {
	test('stays below the anchor when the panel fits there', () => {
		const { side, maxHeight } = resolvePanelPlacement(base());
		expect(side).toBe('bottom');
		// Room to spare, so the design cap governs rather than the viewport.
		expect(maxHeight).toBe(256);
	});

	test('flips above the anchor when it no longer fits below', () => {
		// 800 - 640 - 8 = 152px below, well short of the 256px the panel wants.
		const { side, maxHeight } = resolvePanelPlacement(base({ anchorTop: 600, anchorBottom: 640 }));
		expect(side).toBe('top');
		expect(maxHeight).toBe(256);
	});

	test('takes the roomier side and shrinks to it when neither side fits', () => {
		// 400px band: 102px below the anchor, 242px above. Neither holds 256.
		const { side, maxHeight } = resolvePanelPlacement(
			base({ anchorTop: 250, anchorBottom: 290, viewportBottom: 400 }),
		);
		expect(side).toBe('top');
		expect(maxHeight).toBe(242);
	});

	test('keeps the preferred side on an exact tie', () => {
		// A zero-height anchor centred in the band: 192px either way, neither enough.
		const tie = base({ anchorTop: 200, anchorBottom: 200, viewportBottom: 400 });
		expect(resolvePanelPlacement(tie).side).toBe('bottom');
		expect(resolvePanelPlacement({ ...tie, prefer: 'top' }).side).toBe('top');
	});

	test('prefer: top holds above while it fits and drops below when it does not', () => {
		expect(
			resolvePanelPlacement(base({ anchorTop: 600, anchorBottom: 640, prefer: 'top' })).side,
		).toBe('top');
		// Anchor near the band top: only 92px above, but 652px below.
		expect(resolvePanelPlacement(base({ prefer: 'top' })).side).toBe('bottom');
	});

	test('does not flip before the first measurement', () => {
		// contentHeight 0 is the pre-measure state: nothing is known to overflow
		// yet, so the panel must not jump to a side it may not need.
		const { side } = resolvePanelPlacement(
			base({ anchorTop: 600, anchorBottom: 640, contentHeight: 0 }),
		);
		expect(side).toBe('bottom');
	});

	test('is decided against the band, not the anchor alone', () => {
		const geometry = base({ anchorTop: 250, anchorBottom: 290, viewportBottom: 400 });
		// 242px above vs 102px below -> above.
		expect(resolvePanelPlacement(geometry).side).toBe('top');
		// The same anchor with the band starting at 200 leaves only 42px above,
		// so the roomier side is now below.
		expect(resolvePanelPlacement({ ...geometry, viewportTop: 200 }).side).toBe('bottom');
	});
});

describe('height cap', () => {
	test('the design cap wins when there is room for it', () => {
		expect(resolvePanelPlacement(base({ contentHeight: 5000 })).maxHeight).toBe(256);
	});

	test('without a design cap the cap is the space on the chosen side', () => {
		// 800 - 140 - 8 = 652.
		const { maxHeight } = resolvePanelPlacement(
			base({ preferredMaxHeight: undefined, contentHeight: 300 }),
		);
		expect(maxHeight).toBe(652);
	});

	test('short content is not padded out to the cap', () => {
		// The cap is a `max-height`, so a two-row picker still renders two rows
		// tall. Content height only decides the side, never the cap — capping at
		// a fractional content height would scroll the panel against itself.
		expect(resolvePanelPlacement(base({ contentHeight: 40 })).maxHeight).toBe(256);
	});

	test('subtracts the edge padding from both sides', () => {
		const tight = base({ preferredMaxHeight: undefined, contentHeight: 5000, viewportBottom: 400 });
		expect(resolvePanelPlacement(tight).maxHeight).toBe(252);
		expect(resolvePanelPlacement({ ...tight, padding: 0 }).maxHeight).toBe(260);
	});

	test('floors at the minimum height rather than a sliver', () => {
		// 400 - 396 - 8 clamps to 0 below; 4px above. Both unusable.
		const { maxHeight } = resolvePanelPlacement(
			base({ anchorTop: 12, anchorBottom: 396, viewportBottom: 400 }),
		);
		expect(maxHeight).toBe(PANEL_MIN_HEIGHT_PX);
	});

	test('an anchor filling the whole band still resolves to a usable cap', () => {
		// The fullscreen composer: the anchor is the entire flex column, so both
		// sides clamp to 0. The panel scrolls internally instead of vanishing.
		const { side, maxHeight } = resolvePanelPlacement(base({ anchorTop: 0, anchorBottom: 800 }));
		expect(side).toBe('bottom');
		expect(maxHeight).toBe(PANEL_MIN_HEIGHT_PX);
	});

	test('a band shorter than the minimum height wins over the floor', () => {
		// Nothing can be 96px tall inside a 24px band; overflowing it is the one
		// thing this function exists to prevent.
		const { maxHeight } = resolvePanelPlacement(
			base({ anchorTop: 20, anchorBottom: 30, viewportBottom: 40 }),
		);
		expect(maxHeight).toBe(24);
		expect(maxHeight).toBeGreaterThanOrEqual(0);
	});

	test('never returns a negative cap for an anchor scrolled out of the band', () => {
		const { maxHeight } = resolvePanelPlacement(base({ anchorTop: 900, anchorBottom: 940 }));
		expect(maxHeight).toBeGreaterThanOrEqual(0);
	});
});

describe('constants', () => {
	test('each side maps to its own vertical position classes', () => {
		expect(PANEL_SIDE_CLASS.bottom).toBe('top-full mt-1');
		expect(PANEL_SIDE_CLASS.top).toBe('bottom-full mb-1');
	});

	test('the default padding matches the mt-1/mb-1 offset', () => {
		expect(PANEL_EDGE_PADDING_PX).toBe(8);
	});
});
