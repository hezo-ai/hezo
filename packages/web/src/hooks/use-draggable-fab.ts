import {
	type CSSProperties,
	type MouseEvent as ReactMouseEvent,
	type PointerEvent as ReactPointerEvent,
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from 'react';
import {
	type FabId,
	type FabPosition,
	fabPixelPosition,
	getFabPosition,
	pixelsToFabPosition,
	setFabPosition,
} from '../lib/fab-position';
import { useMediaQuery } from './use-media-query';

/**
 * Below this pointer travel (px) a press is a tap and the button never moves;
 * beyond it the gesture becomes a drag and the resulting click is swallowed.
 */
const DRAG_THRESHOLD_PX = 8;

/** Matches the buttons' `h-12 w-12` before the ref has a measured element. */
const FALLBACK_BUTTON_SIZE = 48;

/**
 * Drag is only offered where the floating buttons overlay content and can
 * occlude it: portrait phone/tablet layouts. Landscape and `lg`+ keep the
 * default fixed corners. Mirrors Tailwind's `lg` boundary (1024px).
 */
const DRAG_MEDIA_QUERY = '(max-width: 1023px) and (orientation: portrait)';

interface DragGesture {
	pointerId: number;
	startX: number;
	startY: number;
	originLeft: number;
	originTop: number;
	/** Set once travel passes the threshold — from then on it's a drag. */
	moved: boolean;
}

export interface DraggableFab {
	ref: RefObject<HTMLButtonElement | null>;
	/**
	 * Inline position when the button has been dragged on a portrait mobile
	 * screen; `undefined` leaves the default corner classes in charge. The
	 * `auto`s neutralize the class-based `bottom-*`/`left-*`/`right-*` anchors.
	 */
	style: CSSProperties | undefined;
	handlers: {
		onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => void;
		onClickCapture: (e: ReactMouseEvent<HTMLButtonElement>) => void;
	};
}

/**
 * Makes a floating action button draggable anywhere in the viewport on
 * portrait mobile screens (camera-app style), so it can be moved off content
 * it would otherwise occlude. Free placement — the button stays exactly where
 * it's dropped, clamped fully on-screen. The position is in-memory only
 * (module-level, per {@link FabId}): it survives the button unmounting and
 * remounting within the page's lifetime but resets on refresh.
 */
export function useDraggableFab(id: FabId): DraggableFab {
	const draggable = useMediaQuery(DRAG_MEDIA_QUERY);
	const ref = useRef<HTMLButtonElement | null>(null);
	const [pos, setPos] = useState<FabPosition | null>(() => getFabPosition(id));
	const [viewport, setViewport] = useState(() =>
		typeof window === 'undefined'
			? { w: 0, h: 0 }
			: { w: window.innerWidth, h: window.innerHeight },
	);
	const posRef = useRef(pos);
	posRef.current = pos;
	const gestureRef = useRef<DragGesture | null>(null);
	const suppressClickRef = useRef(false);
	// Gates the document-level move/up listeners to the lifetime of a gesture.
	const [gestureActive, setGestureActive] = useState(false);

	// Re-clamp on rotation/resize. `window.inner*` is the layout viewport, which
	// is what `position: fixed` elements are laid out against (correct even with
	// the soft keyboard up).
	useEffect(() => {
		if (!draggable) return;
		const update = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
		update();
		window.addEventListener('resize', update);
		window.addEventListener('orientationchange', update);
		return () => {
			window.removeEventListener('resize', update);
			window.removeEventListener('orientationchange', update);
		};
	}, [draggable]);

	useEffect(() => {
		if (!gestureActive) return;
		const buttonSize = () => ({
			w: ref.current?.offsetWidth || FALLBACK_BUTTON_SIZE,
			h: ref.current?.offsetHeight || FALLBACK_BUTTON_SIZE,
		});
		const endGesture = () => {
			gestureRef.current = null;
			setGestureActive(false);
		};
		const onMove = (e: PointerEvent) => {
			const g = gestureRef.current;
			if (!g || e.pointerId !== g.pointerId) return;
			const dx = e.clientX - g.startX;
			const dy = e.clientY - g.startY;
			if (!g.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
			g.moved = true;
			const { w, h } = buttonSize();
			setPos(
				pixelsToFabPosition(
					g.originLeft + dx,
					g.originTop + dy,
					w,
					h,
					window.innerWidth,
					window.innerHeight,
				),
			);
		};
		const onUp = (e: PointerEvent) => {
			const g = gestureRef.current;
			if (!g || e.pointerId !== g.pointerId) return;
			const dropped = g.moved;
			endGesture();
			if (dropped) {
				// A real drag: remember the drop point and swallow the click the
				// browser is about to synthesize on this button.
				suppressClickRef.current = true;
				if (posRef.current) setFabPosition(id, posRef.current);
			}
		};
		const onCancel = (e: PointerEvent) => {
			const g = gestureRef.current;
			if (!g || e.pointerId !== g.pointerId) return;
			endGesture();
			// Revert to the last committed spot (or the default corner).
			setPos(getFabPosition(id));
		};
		document.addEventListener('pointermove', onMove);
		document.addEventListener('pointerup', onUp);
		document.addEventListener('pointercancel', onCancel);
		return () => {
			document.removeEventListener('pointermove', onMove);
			document.removeEventListener('pointerup', onUp);
			document.removeEventListener('pointercancel', onCancel);
		};
	}, [gestureActive, id]);

	const onPointerDown = useCallback(
		(e: ReactPointerEvent<HTMLButtonElement>) => {
			if (!draggable || !e.isPrimary || e.button !== 0) return;
			const el = ref.current;
			if (!el) return;
			const rect = el.getBoundingClientRect();
			gestureRef.current = {
				pointerId: e.pointerId,
				startX: e.clientX,
				startY: e.clientY,
				originLeft: rect.left,
				originTop: rect.top,
				moved: false,
			};
			try {
				el.setPointerCapture(e.pointerId);
			} catch {
				// happy-dom lacks pointer capture; document listeners still work.
			}
			setGestureActive(true);
		},
		[draggable],
	);

	const onClickCapture = useCallback((e: ReactMouseEvent<HTMLButtonElement>) => {
		if (!suppressClickRef.current) return;
		suppressClickRef.current = false;
		e.preventDefault();
		e.stopPropagation();
	}, []);

	let style: CSSProperties | undefined;
	if (draggable && pos) {
		const w = ref.current?.offsetWidth || FALLBACK_BUTTON_SIZE;
		const h = ref.current?.offsetHeight || FALLBACK_BUTTON_SIZE;
		const { left, top } = fabPixelPosition(pos, w, h, viewport.w, viewport.h);
		style = { left, top, right: 'auto', bottom: 'auto' };
	}

	return { ref, style, handlers: { onPointerDown, onClickCapture } };
}
