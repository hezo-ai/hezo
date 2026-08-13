/**
 * Breathing room, in pixels, a segmented control keeps between its widest label
 * and the divider beside it. Without it a label that fits by a hair renders
 * flush against the border and reads as clipped.
 */
export const SEGMENTED_FIT_TOLERANCE_PX = 8;

/**
 * Whether a segmented control can show its text labels at the width it has.
 *
 * A pixel breakpoint cannot answer this: the control's labels come from the
 * active language, so a threshold tuned for "Conversation" clips
 * "Unterhaltung", and one tuned for German collapses English to icons for no
 * reason. The caller measures what the labels actually need and asks here.
 *
 * An unmeasurable width (0, as happy-dom reports, or a detached node) answers
 * "yes": labels are the richer state, so an unknown falls back to showing them
 * rather than hiding them.
 */
export function segmentedLabelsFit(requiredPx: number, availablePx: number): boolean {
	if (!Number.isFinite(requiredPx) || !Number.isFinite(availablePx)) return true;
	if (availablePx <= 0 || requiredPx <= 0) return true;
	return requiredPx + SEGMENTED_FIT_TOLERANCE_PX <= availablePx;
}
