/**
 * How far the org chart is scaled down to sit inside its viewport, and the
 * layout box that scaled chart needs to stand in for it.
 *
 * Pure arithmetic so it unit-tests in the component tier (happy-dom has no
 * layout engine and answers 0 to every measurement); the DOM reads and the
 * ResizeObserver wiring live with the component in
 * `components/org-chart-tree.tsx`.
 *
 * A `transform: scale()` changes what is painted and leaves the layout box
 * alone, so the caller has to give the scaled chart a real box of its own -
 * that is what `width`/`height` are for. Without one, a scrolling chart's
 * scroll extent stays the *unscaled* width and it scrolls into hundreds of
 * pixels of nothing.
 */

/**
 * The chart stops shrinking here and the viewport scrolls instead.
 *
 * Derived from the smallest text in a node: the role line under a named agent
 * is 11px, and 8/11 = 0.727 keeps it at or above 8px. The card's own 13px label
 * lands at ~9.5px. Below this the chart has stopped being readable, and panning
 * a legible tree beats staring at an illegible whole one - which is the entire
 * point of having a floor. Lowering it trades legibility for fitting more
 * roster on screen.
 */
export const ORG_CHART_MIN_SCALE = 0.73;

/**
 * A pixel held back from the width the chart is fitted into.
 *
 * `offsetWidth` and `clientWidth` are both integer-rounded, so a chart measured
 * a fraction narrow would otherwise be scaled to exactly the room available and
 * shear its outermost card's 1px border against the clip. This is the
 * horizontal twin of the pixel added to the height, which guards the bottom
 * row's border (PR #620).
 */
export const ORG_CHART_EDGE_SLACK_PX = 1;

export interface OrgChartFitInput {
	/** Room the viewport gives the chart: its `clientWidth`, scrollbars excluded. */
	viewportWidth: number;
	/** The chart's natural, untransformed width - `offsetWidth` of a `max-content` box. */
	contentWidth: number;
	/** The chart's natural, untransformed height - `offsetHeight`. */
	contentHeight: number;
}

export interface OrgChartFit {
	/** Factor for `transform: scale(...)`. Never above 1 - the chart is not enlarged. */
	scale: number;
	/** Layout width of the box standing in for the scaled chart. */
	width: number;
	/** Its layout height, carrying the slack that keeps the bottom border inside the clip. */
	height: number;
	/** The box is wider than the room, so the viewport has to scroll. */
	overflows: boolean;
}

/** A measurement that never arrived (happy-dom, pre-layout, a `display: none` ancestor). */
function unmeasured(value: number): boolean {
	return !Number.isFinite(value) || value <= 0;
}

/**
 * Fit the chart to the viewport, shrink-only and floored at
 * `ORG_CHART_MIN_SCALE`.
 *
 * Both dimensions round *up*, so the box is never narrower than what is painted
 * inside it. That is safe in the fitting regime only because the scale was
 * derived against `viewportWidth - ORG_CHART_EDGE_SLACK_PX`: rounding a box up
 * to exactly the room available would grow a permanent 1px scrollbar on a chart
 * that fits.
 */
export function computeOrgChartFit({
	viewportWidth,
	contentWidth,
	contentHeight,
}: OrgChartFitInput): OrgChartFit {
	// Nothing has been laid out yet: render at full size rather than deriving a
	// scale from zeroes. The ResizeObserver re-runs this once real boxes exist.
	if (unmeasured(contentWidth) || unmeasured(contentHeight) || unmeasured(viewportWidth)) {
		return { scale: 1, width: 0, height: 0, overflows: false };
	}

	const room = Math.max(1, viewportWidth - ORG_CHART_EDGE_SLACK_PX);
	const scale = Math.min(1, Math.max(ORG_CHART_MIN_SCALE, room / contentWidth));
	const width = Math.ceil(contentWidth * scale);

	return {
		scale,
		width,
		height: Math.ceil(contentHeight * scale) + ORG_CHART_EDGE_SLACK_PX,
		// Asked of the box, not of the scale: a chart clamped at the floor can
		// still land inside the viewport, and it should not scroll for nothing.
		overflows: width > viewportWidth,
	};
}
