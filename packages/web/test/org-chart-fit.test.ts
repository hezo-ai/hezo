/**
 * Pure arithmetic tier: happy-dom has no layout engine, so the scale/clamp/
 * rounding rules can only be exercised here. That the rules produce a chart
 * nothing is clipped out of is a browser matter - see
 * `test/browser/org-chart-fit.spec.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
	computeOrgChartFit,
	ORG_CHART_EDGE_SLACK_PX,
	ORG_CHART_MIN_SCALE,
} from '../src/lib/org-chart-fit';

const HEIGHT = 400;

describe('computeOrgChartFit', () => {
	it('leaves a chart narrower than its viewport at full size', () => {
		const fit = computeOrgChartFit({
			viewportWidth: 1200,
			contentWidth: 800,
			contentHeight: HEIGHT,
		});

		expect(fit.scale).toBe(1);
		expect(fit.overflows).toBe(false);
		expect(fit.width).toBe(800);
	});

	it('never enlarges - a chart with room to spare is not stretched to fill it', () => {
		const fit = computeOrgChartFit({
			viewportWidth: 4000,
			contentWidth: 500,
			contentHeight: HEIGHT,
		});

		expect(fit.scale).toBe(1);
		expect(fit.width).toBe(500);
	});

	it('shrinks a wider chart into the room available', () => {
		const fit = computeOrgChartFit({
			viewportWidth: 1000,
			contentWidth: 1250,
			contentHeight: HEIGHT,
		});

		expect(fit.scale).toBeCloseTo(999 / 1250, 5);
		expect(fit.overflows).toBe(false);
		expect(fit.width).toBeLessThan(1000);
	});

	it('stops shrinking at the floor and reports that the viewport must scroll', () => {
		// A nine-role roster on a phone: fitting it outright would need scale 0.13.
		const fit = computeOrgChartFit({
			viewportWidth: 390,
			contentWidth: 3000,
			contentHeight: HEIGHT,
		});

		expect(fit.scale).toBe(ORG_CHART_MIN_SCALE);
		expect(fit.overflows).toBe(true);
		// Wider than the viewport by construction - that width *is* the scroll extent.
		expect(fit.width).toBe(Math.ceil(3000 * ORG_CHART_MIN_SCALE));
		expect(fit.width).toBeGreaterThan(390);
	});

	it('does not scroll a floored chart that still lands inside the viewport', () => {
		const contentWidth = 1000;
		// The one width where both hold: the pixel of slack pushes the ratio just
		// under the floor, yet the floored box is exactly the viewport wide. A
		// scrollbar here would be for a chart already fully visible.
		const fit = computeOrgChartFit({
			viewportWidth: Math.ceil(contentWidth * ORG_CHART_MIN_SCALE),
			contentWidth,
			contentHeight: HEIGHT,
		});

		expect(fit.scale).toBe(ORG_CHART_MIN_SCALE);
		expect(fit.overflows).toBe(false);
	});

	it('never hands a chart that fits a scrollbar it does not need', () => {
		// The rounding trap: a box rounded up to exactly the room available grows a
		// permanent 1px scroll range. Sweep the awkward ratios.
		for (let viewportWidth = 300; viewportWidth <= 1400; viewportWidth += 7) {
			for (const contentWidth of [301, 617, 999, 1001, 1333, 1499]) {
				const fit = computeOrgChartFit({ viewportWidth, contentWidth, contentHeight: HEIGHT });
				if (fit.scale > ORG_CHART_MIN_SCALE) {
					expect(fit.width).toBeLessThanOrEqual(viewportWidth);
					expect(fit.overflows).toBe(false);
				}
			}
		}
	});

	it('never sizes the box narrower than what is painted inside it', () => {
		// The mirror trap: the sizer clips, so a box short of the painted width
		// shears the outermost card's border.
		for (let viewportWidth = 200; viewportWidth <= 1400; viewportWidth += 11) {
			for (const contentWidth of [457, 913, 1490, 2371]) {
				const fit = computeOrgChartFit({ viewportWidth, contentWidth, contentHeight: HEIGHT });
				expect(fit.width).toBeGreaterThanOrEqual(contentWidth * fit.scale);
				expect(fit.height).toBeGreaterThanOrEqual(HEIGHT * fit.scale);
			}
		}
	});

	it('holds a pixel back on each axis for the scaled 1px borders', () => {
		// Inside the fitting band, where the scale is derived rather than clamped.
		const fit = computeOrgChartFit({
			viewportWidth: 1000,
			contentWidth: 1200,
			contentHeight: 777,
		});

		// Width: the slack comes off the room the scale is derived from, so the box
		// lands inside the viewport rather than flush against it.
		expect(fit.scale).toBeCloseTo((1000 - ORG_CHART_EDGE_SLACK_PX) / 1200, 5);
		expect(fit.width).toBeLessThan(1000);
		// Height: the slack is added, guarding the bottom row's border (PR #620).
		expect(fit.height).toBe(Math.ceil(777 * fit.scale) + ORG_CHART_EDGE_SLACK_PX);
		expect(Number.isInteger(fit.width)).toBe(true);
		expect(Number.isInteger(fit.height)).toBe(true);
	});

	for (const [name, input] of [
		['nothing laid out yet', { viewportWidth: 0, contentWidth: 0, contentHeight: 0 }],
		['viewport not measured', { viewportWidth: 0, contentWidth: 900, contentHeight: HEIGHT }],
		['content not measured', { viewportWidth: 900, contentWidth: 0, contentHeight: HEIGHT }],
		['content has no height', { viewportWidth: 900, contentWidth: 900, contentHeight: 0 }],
		[
			'a non-finite measurement',
			{ viewportWidth: Number.NaN, contentWidth: 900, contentHeight: HEIGHT },
		],
		['a negative measurement', { viewportWidth: -50, contentWidth: 900, contentHeight: HEIGHT }],
	] as const) {
		it(`renders at full size with ${name} rather than dividing by zero`, () => {
			const fit = computeOrgChartFit(input);

			expect(fit.scale).toBe(1);
			expect(fit.overflows).toBe(false);
			// No dimensions are forced onto the sizer until a real measurement lands.
			expect(fit.width).toBe(0);
			expect(fit.height).toBe(0);
		});
	}

	it('keeps the floor legible - the 11px role line stays at or above 8px', () => {
		expect(11 * ORG_CHART_MIN_SCALE).toBeGreaterThanOrEqual(8);
	});
});
