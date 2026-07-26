/**
 * Pure geometry and array math behind drag-to-reorder in a vertical list (the
 * project rail). Kept out of the hook so it can be unit-tested without a DOM —
 * happy-dom has no layout engine, so anything measured lives in Playwright while
 * the arithmetic is asserted here. Same split as `fab-position.ts` under
 * `use-draggable-fab.ts`.
 *
 * "Pitch" throughout is the distance between two consecutive item origins: the
 * item's height plus the flex `gap` between them.
 */

/** Immutably move `items[from]` to index `to`. Out-of-range indices are a no-op. */
export function moveItem<T>(items: T[], from: number, to: number): T[] {
	if (from === to) return items;
	if (from < 0 || from >= items.length || to < 0 || to >= items.length) return items;
	const next = items.slice();
	const [moved] = next.splice(from, 1);
	next.splice(to, 0, moved);
	return next;
}

/** Clamp `value` into `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

/**
 * Which slot a dragged item currently occupies, given how far it has travelled.
 * Rounding at the half-pitch means the gap opens once the item is more than
 * halfway over its neighbour, which is what "it feels like it snapped" means.
 */
export function targetIndexForOffset(
	fromIndex: number,
	deltaY: number,
	pitch: number,
	count: number,
): number {
	if (count <= 0) return 0;
	if (pitch <= 0) return clamp(fromIndex, 0, count - 1);
	return clamp(fromIndex + Math.round(deltaY / pitch), 0, count - 1);
}

/**
 * The `translateY` a *non-dragged* item needs so the gap opens in the right
 * place: everything between the drag's origin and its current slot slides one
 * pitch toward the origin. The dragged item itself follows the pointer and is
 * excluded (returns 0).
 */
export function shiftForIndex(
	index: number,
	fromIndex: number,
	toIndex: number,
	pitch: number,
): number {
	if (index === fromIndex || fromIndex === toIndex) return 0;
	// Dragging down: the items it passed move up into the vacated slot.
	if (toIndex > fromIndex) return index > fromIndex && index <= toIndex ? -pitch : 0;
	// Dragging up: the items it passed move down.
	return index >= toIndex && index < fromIndex ? pitch : 0;
}
