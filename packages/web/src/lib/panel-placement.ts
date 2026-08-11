/**
 * Vertical placement for a dropdown panel anchored to a trigger: which side of
 * the anchor it opens on, and how tall it is allowed to be there.
 *
 * Pure arithmetic over rectangles so it unit-tests in the component tier
 * (happy-dom has no layout engine); the DOM measurement and the
 * resize/scroll wiring live in `hooks/use-panel-placement.ts`.
 *
 * Horizontal anchoring is deliberately not modelled here. The call sites
 * disagree — three panels are full-width `left-0 right-0`, one is `right-0 w-72`
 * — so the horizontal classes stay with the caller and only the vertical side
 * and the height cap are shared.
 *
 * The band the panel must stay inside is passed as an explicit top/bottom pair
 * rather than a height, so a caller can hand in the *visual* viewport (soft
 * keyboard up) or its intersection with a clipping scroll ancestor without this
 * file knowing either exists.
 */

export type PanelSide = 'bottom' | 'top';

/** The vertical half of a panel's position classes, keyed by side. */
export const PANEL_SIDE_CLASS: Record<PanelSide, string> = {
	bottom: 'top-full mt-1',
	top: 'bottom-full mb-1',
};

/** Gap kept between the panel and the band edge. Matches the `mt-1`/`mb-1` offset. */
export const PANEL_EDGE_PADDING_PX = 8;

/**
 * A panel's cap is never squeezed below this. On a band too short to hold it,
 * a slight overhang is better than an unusable sliver — and since the cap is a
 * `max-height`, a panel whose content is shorter still renders short.
 */
export const PANEL_MIN_HEIGHT_PX = 96;

export interface PanelPlacementInput {
	/** Anchor edges in client coordinates (`getBoundingClientRect()`). */
	anchorTop: number;
	anchorBottom: number;
	/** The band the panel must stay inside, in the same coordinates. */
	viewportTop: number;
	viewportBottom: number;
	/**
	 * The panel's natural, unclamped content height (`panel.scrollHeight`). Only
	 * decides the side — never the cap, so a sub-pixel content height can't
	 * produce a cap that scrolls its own content by a fraction of a pixel. `0`
	 * before the first measurement, which resolves to `prefer` unflipped.
	 */
	contentHeight: number;
	/** The side to use whenever it can hold the panel. Defaults to `'bottom'`. */
	prefer?: PanelSide;
	/** The panel's design cap in px (its former `max-h-*`). Omit for "as tall as it fits". */
	preferredMaxHeight?: number;
	padding?: number;
	minHeight?: number;
}

export interface PanelPlacement {
	side: PanelSide;
	/** px cap for the panel box: never past the band, never below `minHeight`. */
	maxHeight: number;
}

/**
 * Choose the side of the anchor with room for the panel, and the height cap
 * that keeps it inside the band.
 *
 * The preferred side wins whenever it can hold the panel whole, so a panel only
 * moves when staying put would clip it; when neither side fits, the roomier one
 * takes it and the panel scrolls internally. Ties keep the preferred side, so a
 * panel centred in its band never oscillates between the two.
 */
export function resolvePanelPlacement({
	anchorTop,
	anchorBottom,
	viewportTop,
	viewportBottom,
	contentHeight,
	prefer = 'bottom',
	preferredMaxHeight,
	padding = PANEL_EDGE_PADDING_PX,
	minHeight = PANEL_MIN_HEIGHT_PX,
}: PanelPlacementInput): PanelPlacement {
	const space: Record<PanelSide, number> = {
		bottom: Math.max(0, viewportBottom - anchorBottom - padding),
		top: Math.max(0, anchorTop - viewportTop - padding),
	};
	const other: PanelSide = prefer === 'bottom' ? 'top' : 'bottom';

	// What the panel would like to occupy: its content, never more than its
	// design cap.
	const desired =
		preferredMaxHeight === undefined ? contentHeight : Math.min(contentHeight, preferredMaxHeight);

	let side: PanelSide;
	if (space[prefer] >= desired) side = prefer;
	else if (space[other] >= desired) side = other;
	else side = space[other] > space[prefer] ? other : prefer;

	// The cap comes from the design cap and the room on the chosen side — not
	// from the content. `max-height` doesn't stretch a short panel, so capping
	// at the available space leaves a two-row picker two rows tall.
	const bandCap = Math.max(0, viewportBottom - viewportTop - 2 * padding);
	const fromSpace = Math.min(preferredMaxHeight ?? space[side], space[side]);
	// The band wins over the floor: a band genuinely shorter than `minHeight`
	// cannot hold `minHeight`, and overflowing it is what this function exists
	// to prevent.
	const maxHeight = Math.min(Math.max(fromSpace, minHeight), bandCap);

	return { side, maxHeight };
}
