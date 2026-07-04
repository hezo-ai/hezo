/**
 * In-memory positions for the draggable floating action buttons (the "+"
 * create-task button and the CEO chat launcher) on portrait mobile screens.
 *
 * Deliberately not persisted: a dragged position is a temporary "get out of my
 * way" adjustment, so it lives in a module-level map — surviving the buttons'
 * unmount/remount cycles (the `hidden` prop, the launcher unmounting while the
 * chat panel is open) but resetting to the default corner on page refresh.
 *
 * Positions are stored as fractions of the *free range* (viewport minus button
 * size) rather than pixels, so a rotation or resize keeps the button at the
 * same relative spot and can never strand it off-screen: pixels are recomputed
 * from the fractions against the current viewport on every render.
 */

export type FabId = 'new-task' | 'ceo-chat';

export interface FabPosition {
	/** 0 = flush left, 1 = flush right, of `viewportWidth - buttonWidth`. */
	xFrac: number;
	/** 0 = flush top, 1 = flush bottom, of `viewportHeight - buttonHeight`. */
	yFrac: number;
}

const positions = new Map<FabId, FabPosition>();

export function getFabPosition(id: FabId): FabPosition | null {
	return positions.get(id) ?? null;
}

export function setFabPosition(id: FabId, pos: FabPosition): void {
	positions.set(id, { xFrac: clamp01(pos.xFrac), yFrac: clamp01(pos.yFrac) });
}

/** Test-only isolation helper — clears all remembered positions. */
export function resetFabPositions(): void {
	positions.clear();
}

function clamp01(n: number): number {
	if (!Number.isFinite(n)) return 0;
	return Math.min(1, Math.max(0, n));
}

/**
 * Resolve a fractional position to concrete `left`/`top` pixels for the
 * current viewport. The free range clamps at 0 so a viewport smaller than the
 * button degrades to the top-left corner instead of negative offsets.
 */
export function fabPixelPosition(
	pos: FabPosition,
	buttonWidth: number,
	buttonHeight: number,
	viewportWidth: number,
	viewportHeight: number,
): { left: number; top: number } {
	return {
		left: clamp01(pos.xFrac) * Math.max(0, viewportWidth - buttonWidth),
		top: clamp01(pos.yFrac) * Math.max(0, viewportHeight - buttonHeight),
	};
}

/**
 * Inverse of {@link fabPixelPosition}: convert a dragged `left`/`top` back to
 * clamped fractions. A degenerate free range (viewport no bigger than the
 * button) maps to 0 on that axis.
 */
export function pixelsToFabPosition(
	left: number,
	top: number,
	buttonWidth: number,
	buttonHeight: number,
	viewportWidth: number,
	viewportHeight: number,
): FabPosition {
	const freeX = Math.max(0, viewportWidth - buttonWidth);
	const freeY = Math.max(0, viewportHeight - buttonHeight);
	return {
		xFrac: freeX > 0 ? clamp01(left / freeX) : 0,
		yFrac: freeY > 0 ? clamp01(top / freeY) : 0,
	};
}
