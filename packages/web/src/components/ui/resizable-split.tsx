import {
	type CSSProperties,
	createContext,
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from 'react';
import { PANEL_MOTION_MS } from '../../lib/panel-motion';
import {
	clampPanelWidth,
	MAX_PANEL_WIDTH,
	MIN_PANEL_WIDTH,
	readStoredPanelWidth,
	writeStoredPanelWidth,
} from '../../lib/panel-width-storage';

/** Keyboard resize step (px) per Arrow press on a focused handle. */
const STEP = 24;

type Side = 'left' | 'right';

/** Whether the split's panel is open, or still playing its exit before unmounting. */
export type PanelPresence = 'open' | 'closing';

const PanelPresenceContext = createContext<PanelPresence>('open');

/**
 * Read the surrounding {@link ResizableSplit}'s panel state. The panel itself
 * reads this to pick its enter or exit animation. A sibling that yields its grid
 * track to the panel reads it too, and must stay out of the grid until this
 * reports `open` again - returning while the panel is still fading out puts both
 * in the slot they share, and the sibling renders behind it.
 */
export function usePanelPresence(): PanelPresence {
	return useContext(PanelPresenceContext);
}

interface UseResizableSplitOptions {
	side: Side;
	/** Persist the dragged width under this localStorage key; omit → resets on reload. */
	storageKey?: string;
}

interface UseResizableSplitResult {
	/** The user-chosen width (px), or `null` before the first resize (responsive default in charge). */
	width: number | null;
	isResizing: boolean;
	/** Ref for the grid container — measured for the container-based max clamp. */
	gridRef: React.RefObject<HTMLDivElement | null>;
	/** Ref for the panel's grid cell — measured at drag start for the width baseline. */
	panelCellRef: React.RefObject<HTMLDivElement | null>;
	handleProps: {
		onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
		onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
	};
}

/**
 * Drag-to-resize state for a two-column split: pointer capture (with a
 * happy-dom `try/catch`), document-level move/up listeners gated by a resizing
 * flag, and a `ResizeObserver` re-clamp when the container shrinks. Reusable on
 * its own for a bespoke grid; {@link ResizableSplit} wraps it with the layout.
 */
export function useResizableSplit({
	side,
	storageKey,
}: UseResizableSplitOptions): UseResizableSplitResult {
	const [width, setWidth] = useState<number | null>(() =>
		storageKey ? readStoredPanelWidth(storageKey) : null,
	);
	const [isResizing, setIsResizing] = useState(false);
	const gridRef = useRef<HTMLDivElement>(null);
	const panelCellRef = useRef<HTMLDivElement>(null);
	const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
	// Mirror width in a ref so the pointer-up handler persists the latest value.
	const widthRef = useRef<number | null>(width);
	widthRef.current = width;

	const containerWidth = useCallback(() => gridRef.current?.getBoundingClientRect().width, []);

	const persist = useCallback(
		(w: number) => {
			if (storageKey) writeStoredPanelWidth(storageKey, w);
		},
		[storageKey],
	);

	const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
		if (!e.isPrimary || e.button !== 0) return;
		const cell = panelCellRef.current;
		if (!cell) return;
		e.preventDefault();
		dragRef.current = {
			pointerId: e.pointerId,
			startX: e.clientX,
			// Baseline off the rendered cell so a drag starting from a responsive
			// default (width still null) picks up the real current width.
			startWidth: cell.getBoundingClientRect().width,
		};
		try {
			e.currentTarget.setPointerCapture(e.pointerId);
		} catch {
			// happy-dom lacks pointer capture; the document listeners still fire.
		}
		setIsResizing(true);
	}, []);

	useEffect(() => {
		if (!isResizing) return;
		// Keep the whole page in the resize cursor and suppress text selection
		// while dragging; restore on gesture end.
		const prevCursor = document.body.style.cursor;
		const prevSelect = document.body.style.userSelect;
		document.body.style.cursor = 'col-resize';
		document.body.style.userSelect = 'none';

		const onMove = (e: PointerEvent) => {
			const d = dragRef.current;
			if (!d || e.pointerId !== d.pointerId) return;
			const dx = e.clientX - d.startX;
			// Dragging the divider toward the main column widens the panel.
			const delta = side === 'right' ? -dx : dx;
			setWidth(clampPanelWidth(d.startWidth + delta, containerWidth()));
		};
		const onUp = (e: PointerEvent) => {
			const d = dragRef.current;
			if (!d || e.pointerId !== d.pointerId) return;
			dragRef.current = null;
			setIsResizing(false);
			if (widthRef.current != null) persist(widthRef.current);
		};
		document.addEventListener('pointermove', onMove);
		document.addEventListener('pointerup', onUp);
		document.addEventListener('pointercancel', onUp);
		return () => {
			document.removeEventListener('pointermove', onMove);
			document.removeEventListener('pointerup', onUp);
			document.removeEventListener('pointercancel', onUp);
			document.body.style.cursor = prevCursor;
			document.body.style.userSelect = prevSelect;
		};
	}, [isResizing, side, containerWidth, persist]);

	const onKeyDown = useCallback(
		(e: ReactKeyboardEvent<HTMLDivElement>) => {
			if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
			e.preventDefault();
			const current =
				widthRef.current ?? panelCellRef.current?.getBoundingClientRect().width ?? MIN_PANEL_WIDTH;
			// The arrow pointing toward the main column widens the panel.
			const towardMain = side === 'right' ? 'ArrowLeft' : 'ArrowRight';
			const dir = e.key === towardMain ? 1 : -1;
			const next = clampPanelWidth(current + dir * STEP, containerWidth());
			setWidth(next);
			persist(next);
		},
		[side, containerWidth, persist],
	);

	// Re-clamp a stored/dragged width when the container shrinks (e.g. viewport
	// resize), so the panel can never leave the main column below its minimum.
	useEffect(() => {
		const grid = gridRef.current;
		if (!grid || typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(() => {
			if (widthRef.current == null) return;
			const clamped = clampPanelWidth(widthRef.current, grid.getBoundingClientRect().width);
			if (clamped !== widthRef.current) setWidth(clamped);
		});
		ro.observe(grid);
		return () => ro.disconnect();
	}, []);

	return { width, isResizing, gridRef, panelCellRef, handleProps: { onPointerDown, onKeyDown } };
}

interface ResizableSplitProps {
	/** Main content — the flexible `1fr` column. */
	children: ReactNode;
	/** The resizable side panel; `null` collapses the layout to `collapsedTrackClass`. */
	panel: ReactNode | null;
	/** Which side the resizable panel sits on. Default `'right'`. */
	side?: Side;
	/** Persist the dragged width in localStorage under this key; omit → resets on reload. */
	storageKey?: string;
	/**
	 * Static `lg:grid-cols-[…]` utility used until the user first drags, so callers
	 * keep their own responsive default. MUST be a literal for Tailwind's JIT.
	 */
	defaultTrackClass: string;
	/**
	 * Static `lg:grid-cols-[…]` utility used when `panel` is `null`. Declare the
	 * same number of tracks as `defaultTrackClass` or the open/close cannot
	 * interpolate and the width snaps: `grid-cols-1` against `1fr 320px` is one
	 * track against two. Omitting this is safe only for a split whose panel is
	 * never `null`.
	 */
	collapsedTrackClass?: string;
	/** Extra classes on the grid container (base breakpoints, etc.). */
	className?: string;
	/** App-specific extra grid siblings (e.g. a meta rail using `lg:contents`). */
	aside?: ReactNode;
}

/**
 * A two-column grid whose side panel can be resized by dragging the divider
 * between the columns. Mobile-first: the grid is a single column at base and the
 * resizable track only engages at `lg+` (the caller's track utilities are all
 * `lg:`-prefixed), so a below-`lg` panel that renders as its own overlay is
 * unaffected. The divider is keyboard-operable and the width optionally persists.
 *
 * It also owns the panel's open/close beat: the track travels between the two
 * caller tracks, a closed panel stays mounted long enough to play its exit, and
 * {@link usePanelPresence} tells the panel - and any sibling that yields its
 * column - which of the two is happening. The track transition is armed per
 * open/close and disarmed straight after, so resizing never inherits it.
 */
export function ResizableSplit({
	children,
	panel,
	side = 'right',
	storageKey,
	defaultTrackClass,
	collapsedTrackClass = '',
	className = '',
	aside,
}: ResizableSplitProps) {
	const { width, isResizing, gridRef, panelCellRef, handleProps } = useResizableSplit({
		side,
		storageKey,
	});

	const hasPanel = panel != null;
	// The last panel stays mounted through the closing beat so its exit has
	// something to play on, while `hasPanel` keeps tracking the live prop - so the
	// grid track collapses and travels at the *start* of the close rather than
	// snapping once it is over.
	const retainedPanel = useRef<ReactNode>(null);
	if (hasPanel) retainedPanel.current = panel;
	const [closing, setClosing] = useState(false);

	// Animate the track only across an open or a close. Arming on the panel
	// appearing or disappearing rather than on the width changing is what keeps a
	// divider drag and an Arrow-key step instant - both write the same property,
	// and a transition left on would lag every one of them by the full beat.
	const prevHasPanel = useRef(hasPanel);
	const [trackArmed, setTrackArmed] = useState(false);
	useEffect(() => {
		if (prevHasPanel.current === hasPanel) return;
		prevHasPanel.current = hasPanel;
		setTrackArmed(true);
		// Both ways round: reopening inside the closing beat must clear the flag
		// immediately, or the panel that just came back plays its exit.
		setClosing(!hasPanel);
		const t = setTimeout(() => {
			setTrackArmed(false);
			setClosing(false);
		}, PANEL_MOTION_MS);
		return () => clearTimeout(t);
	}, [hasPanel]);

	const renderedPanel = hasPanel ? panel : closing ? retainedPanel.current : null;
	const dragged = width != null;
	// Static per-side literals so Tailwind's JIT emits both tracks.
	const varTrack =
		side === 'right' ? 'lg:grid-cols-[1fr_var(--panel-w)]' : 'lg:grid-cols-[var(--panel-w)_1fr]';
	const trackClass = hasPanel ? (dragged ? varTrack : defaultTrackClass) : collapsedTrackClass;
	const trackMotion = trackArmed
		? 'lg:transition-[grid-template-columns] lg:duration-[var(--panel-motion)] lg:ease-in-out motion-reduce:lg:transition-none'
		: '';
	const gridStyle: CSSProperties | undefined =
		hasPanel && dragged ? ({ '--panel-w': `${width}px` } as CSSProperties) : undefined;

	// `contents` below `lg` so the wrapper adds no grid box there — a panel that
	// renders as its own overlay (e.g. `fixed`) then contributes no empty row/gap,
	// and a panel that stacks flows directly. At `lg+` it becomes the positioned
	// grid cell that hosts the divider and any sticky panel.
	const panelCell =
		renderedPanel != null ? (
			<div ref={panelCellRef} className="contents min-w-0 lg:relative lg:block">
				{/* A cell on its way out is not draggable - the width it would write
				    is about to be discarded. */}
				{!closing && (
					<ResizeHandle side={side} active={isResizing} valueNow={width} {...handleProps} />
				)}
				{renderedPanel}
			</div>
		) : null;

	return (
		<PanelPresenceContext.Provider value={closing ? 'closing' : 'open'}>
			<div
				ref={gridRef}
				className={`grid grid-cols-1 gap-5 ${trackClass} ${trackMotion} ${className}`
					.replace(/\s+/g, ' ')
					.trim()}
				style={gridStyle}
			>
				{side === 'left' && panelCell}
				{children}
				{aside}
				{side === 'right' && panelCell}
			</div>
		</PanelPresenceContext.Provider>
	);
}

/**
 * The draggable divider. A wide invisible hit-zone sits in the `gap-5` gutter on
 * the main-content side of the panel, with a thin line that lights up on hover /
 * while active. Desktop-only (`hidden lg:flex`) — below `lg` the panel is its own
 * overlay, so there is nothing to resize.
 */
function ResizeHandle({
	side,
	active,
	valueNow,
	onPointerDown,
	onKeyDown,
}: {
	side: Side;
	active: boolean;
	/** Current panel width (px) for `aria-valuenow`; `null` before the first resize. */
	valueNow: number | null;
	onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
	onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
}) {
	// The gutter is the 20px (`gap-5`) immediately to the main-content side of the cell.
	const gutter = side === 'right' ? '-left-5' : '-right-5';
	return (
		// The WAI-ARIA window-splitter pattern: a focusable `separator` with
		// value semantics. An `<hr>` (useSemanticElements' suggestion) can't be
		// focused or hold the visible line, so the role stays explicit.
		// biome-ignore lint/a11y/useSemanticElements: focusable resize separator, not an <hr>
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label="Resize panel"
			aria-valuenow={valueNow ?? undefined}
			aria-valuemin={MIN_PANEL_WIDTH}
			aria-valuemax={MAX_PANEL_WIDTH}
			tabIndex={0}
			data-testid="resize-handle"
			onPointerDown={onPointerDown}
			onKeyDown={onKeyDown}
			className={`group absolute inset-y-0 ${gutter} z-10 hidden w-5 cursor-col-resize touch-none select-none items-stretch justify-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:flex`}
		>
			<span
				className={`w-0.5 rounded-full transition-colors ${
					active ? 'bg-accent' : 'bg-transparent group-hover:bg-border-strong'
				}`}
			/>
		</div>
	);
}
