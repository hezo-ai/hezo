import { useCallback, useEffect, useRef, useState } from 'react';

/** How long a pointer must stay down before the alternate action arms. */
export const LONG_PRESS_MS = 450;

interface LongPressOptions {
	/** Fired by a quick tap/click, or by keyboard activation. */
	onPress: () => void;
	/** Fired on release after the hold passed {@link LONG_PRESS_MS}. */
	onLongPress: () => void;
	/** When false the hold never arms and every activation is a plain press. */
	enabled?: boolean;
	delayMs?: number;
}

/**
 * Press-and-hold as a second action on one control. A quick tap fires `onPress`;
 * holding past `delayMs` flips `armed` and the release fires `onLongPress`.
 *
 * `armed` is the point of the hook: it lets the control show what a release will
 * do *before* the finger lifts, which is the only way to teach the gesture on
 * touch, where there is no modifier key to hold. Dragging off the control (or a
 * cancelled pointer) aborts without firing either action.
 *
 * Keyboard activation arrives as a bare `click` with no preceding pointer
 * sequence, so it always takes the plain-press path — the pointer handlers mark
 * the click they synthesize so it isn't counted twice.
 */
export function useLongPress({
	onPress,
	onLongPress,
	enabled = true,
	delayMs = LONG_PRESS_MS,
}: LongPressOptions) {
	const [armed, setArmed] = useState(false);
	// Rendered state (not just the ref) so a control can show the hold in progress
	// — a progress sweep, a press affordance — while the threshold runs down.
	const [pressing, setPressing] = useState(false);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pressingRef = useRef(false);
	const armedRef = useRef(false);
	// A pointer sequence that already resolved also emits a `click`; this swallows
	// that one so the press doesn't fire twice.
	const pointerHandledRef = useRef(false);

	const clearTimer = useCallback(() => {
		if (timerRef.current) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}
	}, []);

	// A press left open by an unmount (the panel closes mid-hold) must not fire
	// its timer into a gone component.
	useEffect(() => clearTimer, [clearTimer]);

	// Losing the enabling condition mid-hold (the reply finishes while the finger
	// is down) disarms — releasing then does the plain press, which is what the
	// button now reads as.
	useEffect(() => {
		if (enabled) return;
		clearTimer();
		armedRef.current = false;
		setPressing(false);
		setArmed(false);
	}, [enabled, clearTimer]);

	const cancel = useCallback(() => {
		clearTimer();
		pressingRef.current = false;
		armedRef.current = false;
		setPressing(false);
		setArmed(false);
	}, [clearTimer]);

	const onPointerDown = useCallback(
		(e: React.PointerEvent<HTMLElement>) => {
			// Secondary buttons open menus; they're never an activation.
			if (e.button !== 0) return;
			pressingRef.current = true;
			pointerHandledRef.current = false;
			if (!enabled) return;
			setPressing(true);
			clearTimer();
			timerRef.current = setTimeout(() => {
				timerRef.current = null;
				if (!pressingRef.current) return;
				armedRef.current = true;
				setArmed(true);
			}, delayMs);
		},
		[enabled, delayMs, clearTimer],
	);

	const onPointerUp = useCallback(
		(e: React.PointerEvent<HTMLElement>) => {
			if (e.button !== 0 || !pressingRef.current) return;
			const wasArmed = armedRef.current;
			cancel();
			pointerHandledRef.current = true;
			if (wasArmed) onLongPress();
			else onPress();
		},
		[cancel, onLongPress, onPress],
	);

	// Dragging off the control is the escape hatch: nothing fires. The flag stops
	// the browser's subsequent click from firing the press we just abandoned.
	const onPointerLeave = useCallback(() => {
		if (!pressingRef.current) return;
		cancel();
		pointerHandledRef.current = true;
	}, [cancel]);

	const onClick = useCallback(() => {
		if (pointerHandledRef.current) {
			pointerHandledRef.current = false;
			return;
		}
		onPress();
	}, [onPress]);

	return {
		/** True once the hold passed the threshold — drives the "release does X" affordance. */
		armed,
		/** True for the whole hold, including before it arms — drives progress affordances. */
		pressing,
		handlers: {
			onPointerDown,
			onPointerUp,
			onPointerLeave,
			onPointerCancel: onPointerLeave,
			onClick,
			// A touch-hold would otherwise raise the platform callout mid-gesture.
			onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
		},
	};
}
