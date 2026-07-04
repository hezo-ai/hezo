// Unit tests for useDraggableFab: the portrait-mobile media-query gate, the
// inline style derived from the in-memory position, and the tap-vs-drag
// threshold (a real drag commits the position and swallows the next click; a
// sub-threshold press stays a click). Rendered with a bare button — real
// layout/boundingBox behavior is covered by test/browser/draggable-fabs.mobile.spec.ts.
import { fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useDraggableFab } from '../src/hooks/use-draggable-fab';
import { getFabPosition, resetFabPositions, setFabPosition } from '../src/lib/fab-position';

/** A controllable matchMedia capturing change listeners (theme test pattern). */
function installMatchMedia(matches: boolean) {
	const listeners = new Set<() => void>();
	const mql = {
		matches,
		media: '(max-width: 1023px) and (orientation: portrait)',
		onchange: null,
		addEventListener: (_type: string, cb: () => void) => listeners.add(cb),
		removeEventListener: (_type: string, cb: () => void) => listeners.delete(cb),
		addListener: (cb: () => void) => listeners.add(cb),
		removeListener: (cb: () => void) => listeners.delete(cb),
		dispatchEvent: () => true,
	};
	vi.spyOn(window, 'matchMedia').mockReturnValue(mql as unknown as MediaQueryList);
}

/**
 * happy-dom's PointerEvent support is spotty, so synthesize pointer events as
 * MouseEvents carrying the pointer fields the hook reads (pointerId, isPrimary).
 */
function pointerEvent(
	type: string,
	init: { clientX: number; clientY: number; pointerId?: number },
): MouseEvent {
	const e = new MouseEvent(type, {
		bubbles: true,
		cancelable: true,
		clientX: init.clientX,
		clientY: init.clientY,
		button: 0,
	});
	Object.assign(e, { pointerId: init.pointerId ?? 1, isPrimary: true });
	return e;
}

function TestFab({ onActivate }: { onActivate: () => void }) {
	const fab = useDraggableFab('ceo-chat');
	return (
		<button
			ref={fab.ref}
			type="button"
			data-testid="fab"
			onClick={onActivate}
			{...fab.handlers}
			style={fab.style}
		>
			fab
		</button>
	);
}

beforeEach(() => {
	resetFabPositions();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('style gate', () => {
	test('no stored position → no inline position, default classes stay in charge', () => {
		installMatchMedia(true);
		const { getByTestId } = render(<TestFab onActivate={() => {}} />);
		const btn = getByTestId('fab');
		expect(btn.style.left).toBe('');
		expect(btn.style.top).toBe('');
	});

	test('stored position on portrait mobile → inline px position with anchors neutralized', () => {
		installMatchMedia(true);
		setFabPosition('ceo-chat', { xFrac: 0.5, yFrac: 0.25 });
		const { getByTestId } = render(<TestFab onActivate={() => {}} />);
		const btn = getByTestId('fab');
		// happy-dom has no layout, so the button measures via the 48px fallback.
		const expectedLeft = 0.5 * Math.max(0, window.innerWidth - 48);
		const expectedTop = 0.25 * Math.max(0, window.innerHeight - 48);
		expect(btn.style.left).toBe(`${expectedLeft}px`);
		expect(btn.style.top).toBe(`${expectedTop}px`);
		expect(btn.style.right).toBe('auto');
		expect(btn.style.bottom).toBe('auto');
	});

	test('gate off (desktop/landscape) → stored position is ignored, not cleared', () => {
		installMatchMedia(false);
		setFabPosition('ceo-chat', { xFrac: 0.5, yFrac: 0.25 });
		const { getByTestId } = render(<TestFab onActivate={() => {}} />);
		const btn = getByTestId('fab');
		expect(btn.style.left).toBe('');
		expect(btn.style.top).toBe('');
		expect(getFabPosition('ceo-chat')).toEqual({ xFrac: 0.5, yFrac: 0.25 });
	});
});

describe('tap vs drag', () => {
	test('a sub-threshold press stays a click and never moves the button', () => {
		installMatchMedia(true);
		const onActivate = vi.fn();
		const { getByTestId } = render(<TestFab onActivate={onActivate} />);
		const btn = getByTestId('fab');
		fireEvent(btn, pointerEvent('pointerdown', { clientX: 10, clientY: 10 }));
		fireEvent(document, pointerEvent('pointermove', { clientX: 13, clientY: 13 }));
		fireEvent(document, pointerEvent('pointerup', { clientX: 13, clientY: 13 }));
		fireEvent.click(btn);
		expect(onActivate).toHaveBeenCalledTimes(1);
		expect(getFabPosition('ceo-chat')).toBeNull();
		expect(btn.style.left).toBe('');
	});

	test('a real drag commits the position and swallows exactly the next click', () => {
		installMatchMedia(true);
		const onActivate = vi.fn();
		const { getByTestId } = render(<TestFab onActivate={onActivate} />);
		const btn = getByTestId('fab');
		fireEvent(btn, pointerEvent('pointerdown', { clientX: 10, clientY: 10 }));
		fireEvent(document, pointerEvent('pointermove', { clientX: 60, clientY: 90 }));
		fireEvent(document, pointerEvent('pointerup', { clientX: 60, clientY: 90 }));
		// The drag committed a position…
		const committed = getFabPosition('ceo-chat');
		expect(committed).not.toBeNull();
		expect(btn.style.left).not.toBe('');
		// …and the click the browser synthesizes after pointerup is swallowed.
		fireEvent.click(btn);
		expect(onActivate).not.toHaveBeenCalled();
		// A later plain click works again.
		fireEvent.click(btn);
		expect(onActivate).toHaveBeenCalledTimes(1);
	});

	test('pointercancel reverts to the last committed position', () => {
		installMatchMedia(true);
		setFabPosition('ceo-chat', { xFrac: 0, yFrac: 0 });
		const { getByTestId } = render(<TestFab onActivate={() => {}} />);
		const btn = getByTestId('fab');
		fireEvent(btn, pointerEvent('pointerdown', { clientX: 10, clientY: 10 }));
		fireEvent(document, pointerEvent('pointermove', { clientX: 200, clientY: 200 }));
		fireEvent(document, pointerEvent('pointercancel', { clientX: 200, clientY: 200 }));
		expect(getFabPosition('ceo-chat')).toEqual({ xFrac: 0, yFrac: 0 });
		expect(btn.style.left).toBe('0px');
		expect(btn.style.top).toBe('0px');
	});

	test('drag is inert when the gate is off', () => {
		installMatchMedia(false);
		const onActivate = vi.fn();
		const { getByTestId } = render(<TestFab onActivate={onActivate} />);
		const btn = getByTestId('fab');
		fireEvent(btn, pointerEvent('pointerdown', { clientX: 10, clientY: 10 }));
		fireEvent(document, pointerEvent('pointermove', { clientX: 200, clientY: 200 }));
		fireEvent(document, pointerEvent('pointerup', { clientX: 200, clientY: 200 }));
		expect(getFabPosition('ceo-chat')).toBeNull();
		fireEvent.click(btn);
		expect(onActivate).toHaveBeenCalledTimes(1);
	});
});
