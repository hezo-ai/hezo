import {
	type CSSProperties,
	type DependencyList,
	type RefObject,
	useCallback,
	useLayoutEffect,
	useRef,
	useState,
} from 'react';
import { PANEL_SIDE_CLASS, type PanelSide, resolvePanelPlacement } from '../lib/panel-placement';

export interface PanelPlacementOptions {
	/** Measure and listen only while the panel is up. */
	open: boolean;
	prefer?: PanelSide;
	/** The panel's design cap in px (its former `max-h-*`). */
	preferredMaxHeight?: number;
	/** Values that change the panel's content height — results, rows, a loading flag. */
	deps?: DependencyList;
}

export interface PanelPlacementResult<P extends HTMLElement> {
	/** Attach to the panel element: it is both measured and observed. */
	panelRef: RefObject<P | null>;
	side: PanelSide;
	/** The vertical position classes — concatenate with the caller's own horizontal ones. */
	sideClassName: string;
	/** Spread onto the panel's `style` to apply the height cap. */
	style: CSSProperties;
}

/** A clipping scroll ancestor, resolved once per open so the walk stays off the scroll path. */
interface ClipAncestor {
	el: HTMLElement;
	borderTop: number;
	borderBottom: number;
}

/**
 * Nearest ancestor that clips its overflow vertically — the real ceiling on how
 * tall a panel can be, since an absolutely-positioned element is cut off at its
 * scroll container's padding box however much viewport is left.
 *
 * Returns `null` where the answer can't be trusted: no `getComputedStyle`, or a
 * zero-height rect, which is what a layout-less environment (happy-dom) reports
 * for everything. Falling back to the viewport band there keeps the hook inert
 * rather than wrong.
 */
function resolveClipAncestor(from: HTMLElement): ClipAncestor | null {
	if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return null;
	let el = from.parentElement;
	while (el && el !== document.body) {
		const style = window.getComputedStyle(el);
		// An empty string is happy-dom's "no cascade resolved", not `visible`.
		if (style.overflowY && style.overflowY !== 'visible') {
			const rect = el.getBoundingClientRect();
			if (rect.height === 0) return null;
			return {
				el,
				borderTop: Number.parseFloat(style.borderTopWidth) || 0,
				borderBottom: Number.parseFloat(style.borderBottomWidth) || 0,
			};
		}
		el = el.parentElement;
	}
	return null;
}

/** The band the panel must stay inside: the visual viewport, narrowed by any clipping ancestor. */
function resolveBand(clip: ClipAncestor | null): { top: number; bottom: number } {
	// `visualViewport` is the part of the page actually on screen, so the band
	// shrinks when a mobile soft keyboard covers the bottom of the window.
	// Desktop Chromium has no soft keyboard, so that leg is code-reviewed only.
	const vv = typeof window === 'undefined' ? null : window.visualViewport;
	const top = vv?.offsetTop ?? 0;
	const bottom = top + (vv?.height ?? window.innerHeight);
	if (!clip) return { top, bottom };
	const rect = clip.el.getBoundingClientRect();
	return {
		top: Math.max(top, rect.top + clip.borderTop),
		bottom: Math.min(bottom, rect.bottom - clip.borderBottom),
	};
}

/**
 * Opens a dropdown panel on whichever side of its anchor has room, shrinking it
 * to fit rather than letting it cross the viewport edge: above the anchor near
 * the bottom of the screen, below it near the top, scrolling internally when
 * neither side can hold it whole.
 *
 * Measurement runs in a layout effect, so the resolved side lands in the same
 * frame the panel mounts and there is no visible flash of a wrongly-placed
 * panel. It re-measures on `deps`, on window and visual-viewport resize, on any
 * ancestor scroll (capture phase, so no scroll-parent hunting), and through a
 * ResizeObserver on both anchor and panel — the anchor half being what tracks
 * the comment composer's textarea auto-growing as it is typed into.
 *
 * **The panel must be its own scroll container.** Content height is read from
 * `panel.scrollHeight`, which reports the full content independently of the
 * `max-height` written here only while the panel itself scrolls. Wrap it in a
 * flex shell around an inner scroller instead and flex will shrink that child
 * to the cap, so `scrollHeight` reports the cap straight back and the panel can
 * never grow again once space reopens.
 *
 * That same property is what stops the re-measure looping: the cap cannot move
 * the measured content height, the anchor is unaffected because the panel is out
 * of flow, and the state write is skipped when nothing changed.
 */
export function usePanelPlacement<P extends HTMLElement>(
	anchorRef: RefObject<HTMLElement | null>,
	{ open, prefer = 'bottom', preferredMaxHeight, deps = [] }: PanelPlacementOptions,
): PanelPlacementResult<P> {
	const panelRef = useRef<P | null>(null);
	const clipRef = useRef<ClipAncestor | null>(null);
	const [placement, setPlacement] = useState<{ side: PanelSide; maxHeight: number | undefined }>(
		() => ({ side: prefer, maxHeight: undefined }),
	);

	const measure = useCallback(() => {
		const anchor = anchorRef.current;
		if (!anchor) return;
		const rect = anchor.getBoundingClientRect();
		const band = resolveBand(clipRef.current);
		const next = resolvePanelPlacement({
			anchorTop: rect.top,
			anchorBottom: rect.bottom,
			viewportTop: band.top,
			viewportBottom: band.bottom,
			contentHeight: panelRef.current?.scrollHeight ?? 0,
			prefer,
			preferredMaxHeight,
		});
		setPlacement((prev) =>
			prev.side === next.side && prev.maxHeight === next.maxHeight ? prev : next,
		);
	}, [anchorRef, prefer, preferredMaxHeight]);

	// Listeners live exactly as long as the panel does. The clipping ancestor is
	// resolved here rather than per measure — an ancestor's overflow can't change
	// while the panel is up, so scroll handling never walks the tree.
	useLayoutEffect(() => {
		if (!open) return;
		const anchor = anchorRef.current;
		if (!anchor) return;
		clipRef.current = resolveClipAncestor(anchor);
		measure();

		window.addEventListener('resize', measure);
		document.addEventListener('scroll', measure, { capture: true, passive: true });
		const vv = window.visualViewport;
		vv?.addEventListener('resize', measure);
		vv?.addEventListener('scroll', measure);

		let ro: ResizeObserver | undefined;
		if (typeof ResizeObserver !== 'undefined') {
			ro = new ResizeObserver(measure);
			ro.observe(anchor);
			if (panelRef.current) ro.observe(panelRef.current);
		}

		return () => {
			window.removeEventListener('resize', measure);
			document.removeEventListener('scroll', measure, { capture: true });
			vv?.removeEventListener('resize', measure);
			vv?.removeEventListener('scroll', measure);
			ro?.disconnect();
			clipRef.current = null;
		};
	}, [open, anchorRef, measure]);

	// Content-height signals from the caller. Separate from the effect above so a
	// keystroke re-measures without tearing down and re-adding every listener.
	useLayoutEffect(() => {
		if (!open) return;
		measure();
	}, [open, measure, ...deps]);

	return {
		panelRef,
		side: placement.side,
		sideClassName: PANEL_SIDE_CLASS[placement.side],
		style: { maxHeight: placement.maxHeight },
	};
}
