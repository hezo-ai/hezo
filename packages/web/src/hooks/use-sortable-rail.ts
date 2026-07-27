import {
	type CSSProperties,
	type DragEvent as ReactDragEvent,
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
	type PointerEvent as ReactPointerEvent,
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from 'react';
import { moveItem, shiftForIndex, targetIndexForOffset } from '../lib/list-reorder';

/**
 * Below this pointer travel (px) a mouse press is a click and nothing moves;
 * beyond it the gesture becomes a drag and the resulting click is swallowed.
 * Same threshold and rationale as `use-draggable-fab.ts`.
 */
const DRAG_THRESHOLD_PX = 8;

/**
 * A touch must rest this long before it lifts an avatar. The rail scrolls
 * vertically, so a bare touch-drag would fight the scroll — press-and-hold is the
 * standard disambiguation. Any travel beyond {@link TOUCH_SLOP_PX} before the
 * timer fires means the user meant to scroll, and we bow out entirely.
 */
const LONG_PRESS_MS = 250;
const TOUCH_SLOP_PX = 8;

/** Fallback pitch (avatar height + `gap-2`) before anything has been measured. */
const FALLBACK_PITCH_PX = 44;

/** How close to a scroll edge the pointer must get before the rail auto-scrolls. */
const EDGE_SCROLL_ZONE_PX = 40;
/** Auto-scroll speed at the very edge, in px per animation frame. */
const EDGE_SCROLL_MAX_PX_PER_FRAME = 8;

interface DragGesture {
	pointerId: number;
	fromIndex: number;
	startY: number;
	/** Scroll offset when the gesture began, so auto-scroll folds into the delta. */
	startScrollTop: number;
	/** True once the gesture has been promoted from a press to a real drag. */
	lifted: boolean;
	pitch: number;
	pointerType: string;
	/** Latest pointer position, read by the auto-scroll frame loop. */
	clientY: number;
	/** The item wrapper the press started on; captures the pointer once lifted. */
	element: HTMLElement;
}

export interface SortableItemProps {
	style: CSSProperties;
	draggable: false;
	onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
	onClickCapture: (e: ReactMouseEvent<HTMLElement>) => void;
	onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
	onDragStart: (e: ReactDragEvent<HTMLElement>) => void;
	onContextMenu: (e: ReactMouseEvent<HTMLElement>) => void;
	'data-dragging'?: string;
}

export interface SortableRail {
	/** Attach to the scroll container so the hook can measure and auto-scroll it. */
	containerRef: RefObject<HTMLDivElement | null>;
	/** Props for the wrapper around item `index`. */
	getItemProps: (index: number) => SortableItemProps;
	/** Index currently being dragged, or null. */
	draggingIndex: number | null;
	/** Text for the visually-hidden live region after a keyboard move. */
	announcement: string;
}

export interface UseSortableRailOptions<T> {
	items: T[];
	/** Off entirely when false — no handlers, no styles, markup stays inert. */
	enabled: boolean;
	/** Commit a move. Called once per completed drag or keyboard step. */
	onReorder: (from: number, to: number) => void;
	/** Label for the live-region announcement, e.g. the project name. */
	labelFor: (item: T) => string;
}

/**
 * Drag-to-reorder for the vertical project rail, hand-rolled on Pointer Events
 * in the shape of `use-draggable-fab.ts` (the repo carries no DnD library).
 *
 * Everything moves via `translateY` *inside* the scroll container: the dragged
 * item follows the pointer, the items it passes slide one pitch out of the way.
 * Nothing is portalled out, so the rail's `overflow-y-auto` never has a lifted
 * element to clip.
 *
 * Activation differs by input, because the rail itself scrolls:
 * - mouse: press, then travel past {@link DRAG_THRESHOLD_PX};
 * - touch: press and hold for {@link LONG_PRESS_MS} without moving. A touch that
 *   travels first is a scroll and is left entirely to the browser.
 *
 * The document listeners are attached synchronously from `pointerdown` rather
 * than from a state-driven effect: a fast pointer can emit its whole move
 * sequence inside the frame React would take to re-render, and the gesture would
 * be missed entirely. Native HTML5 dragging is suppressed too — rail items are
 * anchors, and Chromium's own link-drag would otherwise `pointercancel` us.
 *
 * Keyboard path: `Alt+ArrowUp` / `Alt+ArrowDown` on a focused item moves it one
 * slot. Alt-modified so it never shadows browser scrolling or a screen reader's
 * own arrow navigation.
 */
export function useSortableRail<T>({
	items,
	enabled,
	onReorder,
	labelFor,
}: UseSortableRailOptions<T>): SortableRail {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const gestureRef = useRef<DragGesture | null>(null);
	const suppressClickRef = useRef(false);
	const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const detachRef = useRef<(() => void) | null>(null);
	const rafRef = useRef<number | null>(null);

	const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
	const [dragDelta, setDragDelta] = useState(0);
	const [targetIndex, setTargetIndex] = useState<number | null>(null);
	const [announcement, setAnnouncement] = useState('');

	// Read from inside the document listeners, which outlive a given render.
	const itemsRef = useRef(items);
	itemsRef.current = items;
	const onReorderRef = useRef(onReorder);
	onReorderRef.current = onReorder;
	const labelForRef = useRef(labelFor);
	labelForRef.current = labelFor;

	const clearLongPress = useCallback(() => {
		if (longPressTimerRef.current === null) return;
		clearTimeout(longPressTimerRef.current);
		longPressTimerRef.current = null;
	}, []);

	const stopAutoScroll = useCallback(() => {
		if (rafRef.current === null) return;
		cancelAnimationFrame(rafRef.current);
		rafRef.current = null;
	}, []);

	const endGesture = useCallback(() => {
		gestureRef.current = null;
		clearLongPress();
		stopAutoScroll();
		detachRef.current?.();
		detachRef.current = null;
		setDraggingIndex(null);
		setTargetIndex(null);
		setDragDelta(0);
	}, [clearLongPress, stopAutoScroll]);

	// Tear the gesture down if the component unmounts mid-drag.
	useEffect(() => endGesture, [endGesture]);

	/**
	 * Measure the distance between two consecutive item origins from the live DOM,
	 * so the maths tracks whatever the rail's gap and avatar size actually are.
	 */
	const measurePitch = useCallback((): number => {
		const container = containerRef.current;
		if (!container) return FALLBACK_PITCH_PX;
		const children = container.querySelectorAll('[data-sortable-index]');
		if (children.length < 2) return FALLBACK_PITCH_PX;
		const pitch = children[1].getBoundingClientRect().top - children[0].getBoundingClientRect().top;
		// happy-dom reports zeros for every rect; fall back rather than divide by 0.
		return pitch > 0 ? pitch : FALLBACK_PITCH_PX;
	}, []);

	const applyMove = useCallback((from: number, to: number) => {
		if (from === to) return;
		const list = itemsRef.current;
		const item = list[from];
		if (item === undefined) return;
		onReorderRef.current(from, to);
		setAnnouncement(`${labelForRef.current(item)} moved to position ${to + 1} of ${list.length}`);
	}, []);

	/** Recompute the dragged item's offset and the slot it currently occupies. */
	const syncToPointer = useCallback(() => {
		const g = gestureRef.current;
		if (!g) return;
		const container = containerRef.current;
		const scrolled = container ? container.scrollTop - g.startScrollTop : 0;
		const delta = g.clientY - g.startY + scrolled;
		setDragDelta(delta);
		setTargetIndex(targetIndexForOffset(g.fromIndex, delta, g.pitch, itemsRef.current.length));
	}, []);

	/**
	 * Scroll the rail when the pointer nears an edge of an overflowing list, so a
	 * project can be dragged past the visible window.
	 */
	const startAutoScroll = useCallback(() => {
		if (rafRef.current !== null) return;
		const step = () => {
			const g = gestureRef.current;
			const container = containerRef.current;
			if (!g || !container) {
				rafRef.current = null;
				return;
			}
			const rect = container.getBoundingClientRect();
			const maxScroll = container.scrollHeight - container.clientHeight;
			const y = g.clientY;
			let dy = 0;
			if (y < rect.top + EDGE_SCROLL_ZONE_PX && container.scrollTop > 0) {
				const depth = (rect.top + EDGE_SCROLL_ZONE_PX - y) / EDGE_SCROLL_ZONE_PX;
				dy = -Math.min(1, depth) * EDGE_SCROLL_MAX_PX_PER_FRAME;
			} else if (y > rect.bottom - EDGE_SCROLL_ZONE_PX && container.scrollTop < maxScroll) {
				const depth = (y - (rect.bottom - EDGE_SCROLL_ZONE_PX)) / EDGE_SCROLL_ZONE_PX;
				dy = Math.min(1, depth) * EDGE_SCROLL_MAX_PX_PER_FRAME;
			}
			if (dy !== 0) {
				container.scrollTop += dy;
				syncToPointer();
			}
			rafRef.current = requestAnimationFrame(step);
		};
		rafRef.current = requestAnimationFrame(step);
	}, [syncToPointer]);

	/** Promote a press to a real drag. */
	const lift = useCallback(() => {
		const g = gestureRef.current;
		if (!g || g.lifted) return;
		g.lifted = true;
		clearLongPress();
		// Capture only once the gesture is genuinely a drag. Capturing on
		// `pointerdown` instead would retarget the *click* that ends an ordinary
		// press from the inner `<a>` to this wrapper, so tapping a project would
		// stop navigating — the capture boundary, not the click-suppression, is
		// what swallows it. By the time we lift, suppressing the click is exactly
		// what we want anyway.
		try {
			g.element.setPointerCapture(g.pointerId);
		} catch {
			// happy-dom lacks pointer capture; document listeners still work.
		}
		setDraggingIndex(g.fromIndex);
		setTargetIndex(g.fromIndex);
		syncToPointer();
		startAutoScroll();
	}, [clearLongPress, syncToPointer, startAutoScroll]);

	const onPointerDown = useCallback(
		(index: number, e: ReactPointerEvent<HTMLElement>) => {
			if (!enabled || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
			// A second press while one is in flight would leave orphaned listeners.
			endGesture();
			// A drop that produced no synthesized click (released over dead space, or
			// the item unmounted) would otherwise leave the flag armed and swallow
			// this press's click instead. A new press always ends the old window.
			suppressClickRef.current = false;

			gestureRef.current = {
				pointerId: e.pointerId,
				fromIndex: index,
				startY: e.clientY,
				startScrollTop: containerRef.current?.scrollTop ?? 0,
				lifted: false,
				pitch: measurePitch(),
				pointerType: e.pointerType,
				clientY: e.clientY,
				element: e.currentTarget,
			};

			const onMove = (ev: PointerEvent) => {
				const g = gestureRef.current;
				if (!g || ev.pointerId !== g.pointerId) return;
				g.clientY = ev.clientY;
				if (g.lifted) {
					syncToPointer();
					return;
				}
				const travel = Math.abs(ev.clientY - g.startY);
				if (g.pointerType === 'touch') {
					// Moving before the hold completes means "scroll", not "reorder".
					if (travel > TOUCH_SLOP_PX) endGesture();
					return;
				}
				if (travel >= DRAG_THRESHOLD_PX) lift();
			};
			const onUp = (ev: PointerEvent) => {
				const g = gestureRef.current;
				if (!g || ev.pointerId !== g.pointerId) return;
				if (!g.lifted) {
					// Released before promotion — a plain click or tap; let it through.
					endGesture();
					return;
				}
				const container = containerRef.current;
				const scrolled = container ? container.scrollTop - g.startScrollTop : 0;
				const from = g.fromIndex;
				const to = targetIndexForOffset(
					from,
					ev.clientY - g.startY + scrolled,
					g.pitch,
					itemsRef.current.length,
				);
				endGesture();
				// Swallow the click the browser is about to synthesize, or the rail
				// would navigate to the project that was just dropped.
				suppressClickRef.current = true;
				applyMove(from, to);
			};
			const onCancel = (ev: PointerEvent) => {
				const g = gestureRef.current;
				if (g && ev.pointerId !== g.pointerId) return;
				endGesture();
			};
			// Non-passive: once an avatar is lifted the browser must not also scroll.
			const onTouchMove = (ev: TouchEvent) => {
				if (gestureRef.current?.lifted) ev.preventDefault();
			};

			document.addEventListener('pointermove', onMove);
			document.addEventListener('pointerup', onUp);
			document.addEventListener('pointercancel', onCancel);
			document.addEventListener('touchmove', onTouchMove, { passive: false });
			detachRef.current = () => {
				document.removeEventListener('pointermove', onMove);
				document.removeEventListener('pointerup', onUp);
				document.removeEventListener('pointercancel', onCancel);
				document.removeEventListener('touchmove', onTouchMove);
			};

			if (e.pointerType !== 'touch') return;
			longPressTimerRef.current = setTimeout(() => {
				longPressTimerRef.current = null;
				lift();
			}, LONG_PRESS_MS);
		},
		[enabled, measurePitch, endGesture, lift, syncToPointer, applyMove],
	);

	const onClickCapture = useCallback((e: ReactMouseEvent<HTMLElement>) => {
		if (!suppressClickRef.current) return;
		suppressClickRef.current = false;
		e.preventDefault();
		e.stopPropagation();
	}, []);

	const onKeyDown = useCallback(
		(index: number, e: ReactKeyboardEvent<HTMLElement>) => {
			if (!enabled || !e.altKey) return;
			if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
			const to = index + (e.key === 'ArrowDown' ? 1 : -1);
			if (to < 0 || to >= itemsRef.current.length) return;
			e.preventDefault();
			applyMove(index, to);
		},
		[enabled, applyMove],
	);

	const getItemProps = useCallback(
		(index: number): SortableItemProps => {
			const dragging = draggingIndex === index;
			const to = targetIndex ?? draggingIndex;
			const pitch = gestureRef.current?.pitch ?? FALLBACK_PITCH_PX;
			const shift =
				draggingIndex === null || to === null ? 0 : shiftForIndex(index, draggingIndex, to, pitch);
			const offset = dragging ? dragDelta : shift;

			const style: CSSProperties = {
				// Base state stays scrollable; only a lifted item takes the pointer
				// stream away from the browser's own scrolling.
				touchAction: dragging ? 'none' : 'manipulation',
				transform: offset === 0 ? undefined : `translateY(${offset}px)`,
				// The dragged item must track the pointer exactly; its displaced
				// neighbours animate into place.
				transition: dragging || draggingIndex === null ? undefined : 'transform 150ms ease',
				zIndex: dragging ? 10 : undefined,
				position: dragging ? 'relative' : undefined,
				...(dragging ? { scale: '1.08', filter: 'drop-shadow(0 4px 8px rgb(0 0 0 / 0.35))' } : {}),
				...(enabled
					? { userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }
					: {}),
			};

			return {
				style,
				// Rail items are anchors. Chromium's native link-drag would hijack the
				// gesture and `pointercancel` it, so it is suppressed outright.
				draggable: false,
				onDragStart: (e) => e.preventDefault(),
				onPointerDown: (e) => onPointerDown(index, e),
				onClickCapture,
				onKeyDown: (e) => onKeyDown(index, e),
				// iOS pops a callout on long-press; the gesture owns that press.
				onContextMenu: (e) => {
					if (draggingIndex !== null) e.preventDefault();
				},
				...(dragging ? { 'data-dragging': 'true' } : {}),
			};
		},
		[draggingIndex, targetIndex, dragDelta, enabled, onPointerDown, onClickCapture, onKeyDown],
	);

	return { containerRef, getItemProps, draggingIndex, announcement };
}

/** Re-exported so callers can build the optimistic list without a second import. */
export { moveItem };
