// Generic, key-parameterised persistence for a resizable panel's width. The
// user's dragged width is written to localStorage under a caller-supplied key so
// it survives reloads. Modelled on `task-filter-storage.ts`: clamp/validate on
// read so a tampered or stale entry can never feed a garbage width into the grid.

import { readStored, writeStored } from './safe-storage';

/** Narrowest a resizable panel may become (px) — below this a document is unreadable. */
export const MIN_PANEL_WIDTH = 280;
/** Absolute cap for a stored width (px), independent of the live container size. */
export const MAX_PANEL_WIDTH = 1200;
/** The flexible main column keeps at least this much room (px) when the panel widens. */
export const MIN_MAIN_WIDTH = 380;

/**
 * Clamp a candidate panel width to `[MIN_PANEL_WIDTH, min(MAX_PANEL_WIDTH,
 * containerWidth − MIN_MAIN_WIDTH)]`. `containerWidth` is omitted for the
 * storage-only bound (no live layout to measure); pass it during a drag so the
 * main column always keeps `MIN_MAIN_WIDTH`.
 */
export function clampPanelWidth(px: number, containerWidth?: number): number {
	const containerMax =
		containerWidth != null && Number.isFinite(containerWidth)
			? containerWidth - MIN_MAIN_WIDTH
			: Number.POSITIVE_INFINITY;
	const upper = Math.min(MAX_PANEL_WIDTH, containerMax);
	// Never return below the floor even if the container is too narrow to honour it.
	return Math.max(MIN_PANEL_WIDTH, Math.min(px, Math.max(MIN_PANEL_WIDTH, upper)));
}

/**
 * The persisted width for `key`, or `null` when nothing valid is stored (so the
 * caller falls back to its responsive default). Tolerates malformed / non-numeric
 * entries by returning `null`.
 */
export function readStoredPanelWidth(key: string): number | null {
	if (typeof window === 'undefined' || !key) return null;
	const raw = readStored(key);
	if (raw == null || raw === '') return null;
	const n = Number(raw);
	if (!Number.isFinite(n)) return null;
	return Math.round(clampPanelWidth(n));
}

export function writeStoredPanelWidth(key: string, px: number): void {
	if (typeof window === 'undefined' || !key || !Number.isFinite(px)) return;
	writeStored(key, String(Math.round(clampPanelWidth(px))));
}
