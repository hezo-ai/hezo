import {
	type CSSProperties,
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from 'react';
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
 * Drag-to-resize state for a two-column split. The pointer mechanics mirror
 * {@link file://../../hooks/use-draggable-fab.ts}: pointer capture (with a
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
	/** Static `lg:grid-cols-[…]` utility used when `panel` is `null`. */
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
	const dragged = width != null;
	// Static per-side literals so Tailwind's JIT emits both tracks.
	const varTrack =
		side === 'right' ? 'lg:grid-cols-[1fr_var(--panel-w)]' : 'lg:grid-cols-[var(--panel-w)_1fr]';
	const trackClass = hasPanel ? (dragged ? varTrack : defaultTrackClass) : collapsedTrackClass;
	const gridStyle: CSSProperties | undefined =
		hasPanel && dragged ? ({ '--panel-w': `${width}px` } as CSSProperties) : undefined;

	// `contents` below `lg` so the wrapper adds no grid box there — a panel that
	// renders as its own overlay (e.g. `fixed`) then contributes no empty row/gap,
	// and a panel that stacks flows directly. At `lg+` it becomes the positioned
	// grid cell that hosts the divider and any sticky panel.
	const panelCell = hasPanel ? (
		<div ref={panelCellRef} className="contents min-w-0 lg:relative lg:block">
			<ResizeHandle side={side} active={isResizing} valueNow={width} {...handleProps} />
			{panel}
		</div>
	) : null;

	return (
		<div
			ref={gridRef}
			className={`grid grid-cols-1 gap-5 ${trackClass} ${className}`.trim()}
			style={gridStyle}
		>
			{side === 'left' && panelCell}
			{children}
			{aside}
			{side === 'right' && panelCell}
		</div>
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
