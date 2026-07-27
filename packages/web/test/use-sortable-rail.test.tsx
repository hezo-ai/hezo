// Unit tests for useSortableRail's gesture state machine: mouse tap-vs-drag
// threshold, the touch long-press that keeps a swipe a scroll, click
// suppression after a real drag, pointercancel, the keyboard path, and the
// enabled gate. Rendered with bare divs — happy-dom has no layout engine, so
// every rect is zero and the hook falls back to its 44px pitch constant, which
// makes the slot maths deterministic here. Real geometry (drag against actual
// avatar positions, edge auto-scroll, touch pointerType) is covered by
// test/browser/project-rail-reorder{,.mobile}.spec.ts.
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useSortableRail } from '../src/hooks/use-sortable-rail';

/** The hook's FALLBACK_PITCH_PX — what an unmeasurable happy-dom rail falls back to. */
const PITCH = 44;
/** The hook's LONG_PRESS_MS. */
const LONG_PRESS_MS = 250;

/**
 * happy-dom's PointerEvent support is spotty, so synthesize pointer events as
 * MouseEvents carrying the pointer fields the hook reads. Same approach as
 * use-draggable-fab.test.tsx, plus `pointerType`, which drives this hook's
 * mouse-threshold vs touch-long-press branch.
 */
function pointerEvent(
	type: string,
	init: { clientY: number; pointerId?: number; pointerType?: string },
): MouseEvent {
	const e = new MouseEvent(type, {
		bubbles: true,
		cancelable: true,
		clientX: 30,
		clientY: init.clientY,
		button: 0,
	});
	Object.assign(e, {
		pointerId: init.pointerId ?? 1,
		isPrimary: true,
		pointerType: init.pointerType ?? 'mouse',
	});
	return e;
}

const ITEMS = ['alpha', 'beta', 'gamma'];

interface HarnessProps {
	onReorder: (from: number, to: number) => void;
	onItemClick?: (slug: string) => void;
	enabled?: boolean;
}

function Harness({ onReorder, onItemClick, enabled = true }: HarnessProps) {
	const rail = useSortableRail<string>({
		items: ITEMS,
		enabled,
		onReorder,
		labelFor: (item) => item,
	});
	return (
		<div ref={rail.containerRef} data-testid="rail">
			{ITEMS.map((item, index) => (
				<div
					key={item}
					data-sortable-index={index}
					data-testid={`wrapper-${item}`}
					{...rail.getItemProps(index)}
				>
					{/* Stands in for the rail's <Link>: the thing a suppressed click must not reach. */}
					<button type="button" data-testid={`item-${item}`} onClick={() => onItemClick?.(item)}>
						{item}
					</button>
				</div>
			))}
			<span data-testid="announcement">{rail.announcement}</span>
			<span data-testid="dragging">{String(rail.draggingIndex)}</span>
		</div>
	);
}

/** Press on an item, travel to `toY`, release. `startY` defaults to 0. */
function mouseDrag(
	wrapper: HTMLElement,
	toY: number,
	options: { startY?: number; release?: boolean } = {},
) {
	const startY = options.startY ?? 0;
	fireEvent(wrapper, pointerEvent('pointerdown', { clientY: startY }));
	fireEvent(document, pointerEvent('pointermove', { clientY: toY }));
	if (options.release !== false) {
		fireEvent(document, pointerEvent('pointerup', { clientY: toY }));
	}
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('mouse: tap vs drag', () => {
	test('a sub-threshold press is a click, not a reorder', () => {
		const onReorder = vi.fn();
		const onItemClick = vi.fn();
		const { getByTestId } = render(<Harness onReorder={onReorder} onItemClick={onItemClick} />);

		// 4px of travel — under the hook's 8px DRAG_THRESHOLD_PX.
		mouseDrag(getByTestId('wrapper-alpha'), 4);
		fireEvent.click(getByTestId('item-alpha'));

		expect(onReorder).not.toHaveBeenCalled();
		expect(onItemClick).toHaveBeenCalledWith('alpha');
	});

	test('dragging one pitch down moves the item one slot and swallows the click', () => {
		const onReorder = vi.fn();
		const onItemClick = vi.fn();
		const { getByTestId } = render(<Harness onReorder={onReorder} onItemClick={onItemClick} />);

		mouseDrag(getByTestId('wrapper-alpha'), PITCH);
		expect(onReorder).toHaveBeenCalledWith(0, 1);

		// The browser synthesizes a click after the drop; it must not navigate.
		fireEvent.click(getByTestId('item-alpha'));
		expect(onItemClick).not.toHaveBeenCalled();
	});

	test('dragging up moves the item toward the top', () => {
		const onReorder = vi.fn();
		const { getByTestId } = render(<Harness onReorder={onReorder} />);

		mouseDrag(getByTestId('wrapper-gamma'), 0, { startY: PITCH * 2 });
		expect(onReorder).toHaveBeenCalledWith(2, 0);
	});

	test('travel is clamped to the ends of the list', () => {
		const onReorder = vi.fn();
		const { getByTestId } = render(<Harness onReorder={onReorder} />);

		mouseDrag(getByTestId('wrapper-alpha'), PITCH * 10);
		expect(onReorder).toHaveBeenCalledWith(0, 2);
	});

	test('a drag that returns to its own slot commits nothing but still swallows the click', () => {
		const onReorder = vi.fn();
		const onItemClick = vi.fn();
		const { getByTestId } = render(<Harness onReorder={onReorder} onItemClick={onItemClick} />);

		const wrapper = getByTestId('wrapper-alpha');
		fireEvent(wrapper, pointerEvent('pointerdown', { clientY: 0 }));
		fireEvent(document, pointerEvent('pointermove', { clientY: PITCH }));
		fireEvent(document, pointerEvent('pointermove', { clientY: 0 }));
		fireEvent(document, pointerEvent('pointerup', { clientY: 0 }));

		expect(onReorder).not.toHaveBeenCalled();
		fireEvent.click(getByTestId('item-alpha'));
		expect(onItemClick).not.toHaveBeenCalled();
	});

	test('the lifted item is reported as dragging until release', () => {
		const { getByTestId } = render(<Harness onReorder={vi.fn()} />);

		mouseDrag(getByTestId('wrapper-beta'), PITCH, { release: false });
		expect(getByTestId('dragging').textContent).toBe('1');

		fireEvent(document, pointerEvent('pointerup', { clientY: PITCH }));
		expect(getByTestId('dragging').textContent).toBe('null');
	});

	test('pointercancel aborts without committing a move', () => {
		const onReorder = vi.fn();
		const { getByTestId } = render(<Harness onReorder={onReorder} />);

		mouseDrag(getByTestId('wrapper-alpha'), PITCH, { release: false });
		fireEvent(document, pointerEvent('pointercancel', { clientY: PITCH }));

		expect(onReorder).not.toHaveBeenCalled();
		expect(getByTestId('dragging').textContent).toBe('null');
	});

	test('events from a different pointer are ignored mid-gesture', () => {
		const onReorder = vi.fn();
		const { getByTestId } = render(<Harness onReorder={onReorder} />);

		fireEvent(getByTestId('wrapper-alpha'), pointerEvent('pointerdown', { clientY: 0 }));
		fireEvent(document, pointerEvent('pointermove', { clientY: PITCH, pointerId: 99 }));
		fireEvent(document, pointerEvent('pointerup', { clientY: PITCH, pointerId: 99 }));

		expect(onReorder).not.toHaveBeenCalled();
	});
});

describe('touch: long-press vs scroll', () => {
	test('moving before the hold completes is a scroll and never reorders', () => {
		vi.useFakeTimers();
		const onReorder = vi.fn();
		const { getByTestId } = render(<Harness onReorder={onReorder} />);

		const wrapper = getByTestId('wrapper-alpha');
		fireEvent(wrapper, pointerEvent('pointerdown', { clientY: 0, pointerType: 'touch' }));
		// Past the 8px touch slop before the timer fires — the user meant to scroll.
		fireEvent(document, pointerEvent('pointermove', { clientY: 40, pointerType: 'touch' }));
		act(() => vi.advanceTimersByTime(LONG_PRESS_MS + 50));
		fireEvent(document, pointerEvent('pointermove', { clientY: PITCH * 2, pointerType: 'touch' }));
		fireEvent(document, pointerEvent('pointerup', { clientY: PITCH * 2, pointerType: 'touch' }));

		expect(onReorder).not.toHaveBeenCalled();
		expect(getByTestId('dragging').textContent).toBe('null');
	});

	test('holding still past the long press lifts the item, then dragging reorders', () => {
		vi.useFakeTimers();
		const onReorder = vi.fn();
		const { getByTestId } = render(<Harness onReorder={onReorder} />);

		const wrapper = getByTestId('wrapper-alpha');
		fireEvent(wrapper, pointerEvent('pointerdown', { clientY: 0, pointerType: 'touch' }));
		act(() => vi.advanceTimersByTime(LONG_PRESS_MS + 10));
		expect(getByTestId('dragging').textContent).toBe('0');

		fireEvent(document, pointerEvent('pointermove', { clientY: PITCH, pointerType: 'touch' }));
		fireEvent(document, pointerEvent('pointerup', { clientY: PITCH, pointerType: 'touch' }));
		expect(onReorder).toHaveBeenCalledWith(0, 1);
	});

	test('a tap released before the hold completes stays a tap', () => {
		vi.useFakeTimers();
		const onReorder = vi.fn();
		const onItemClick = vi.fn();
		const { getByTestId } = render(<Harness onReorder={onReorder} onItemClick={onItemClick} />);

		const wrapper = getByTestId('wrapper-alpha');
		fireEvent(wrapper, pointerEvent('pointerdown', { clientY: 0, pointerType: 'touch' }));
		act(() => vi.advanceTimersByTime(LONG_PRESS_MS - 100));
		fireEvent(document, pointerEvent('pointerup', { clientY: 0, pointerType: 'touch' }));
		// The timer must not fire after release and strand a lifted item.
		act(() => vi.advanceTimersByTime(500));

		expect(onReorder).not.toHaveBeenCalled();
		expect(getByTestId('dragging').textContent).toBe('null');
		fireEvent.click(getByTestId('item-alpha'));
		expect(onItemClick).toHaveBeenCalledWith('alpha');
	});
});

describe('keyboard', () => {
	test('Alt+ArrowDown moves the item down and announces the new position', () => {
		const onReorder = vi.fn();
		const { getByTestId } = render(<Harness onReorder={onReorder} />);

		fireEvent.keyDown(getByTestId('wrapper-alpha'), { key: 'ArrowDown', altKey: true });

		expect(onReorder).toHaveBeenCalledWith(0, 1);
		expect(getByTestId('announcement').textContent).toBe('alpha moved to position 2 of 3');
	});

	test('Alt+ArrowUp moves the item up', () => {
		const onReorder = vi.fn();
		const { getByTestId } = render(<Harness onReorder={onReorder} />);

		fireEvent.keyDown(getByTestId('wrapper-gamma'), { key: 'ArrowUp', altKey: true });
		expect(onReorder).toHaveBeenCalledWith(2, 1);
	});

	test('it stops at the ends of the list', () => {
		const onReorder = vi.fn();
		const { getByTestId } = render(<Harness onReorder={onReorder} />);

		fireEvent.keyDown(getByTestId('wrapper-alpha'), { key: 'ArrowUp', altKey: true });
		fireEvent.keyDown(getByTestId('wrapper-gamma'), { key: 'ArrowDown', altKey: true });
		expect(onReorder).not.toHaveBeenCalled();
	});

	test('an unmodified arrow key is left to the browser and the screen reader', () => {
		const onReorder = vi.fn();
		const { getByTestId } = render(<Harness onReorder={onReorder} />);

		fireEvent.keyDown(getByTestId('wrapper-alpha'), { key: 'ArrowDown' });
		fireEvent.keyDown(getByTestId('wrapper-alpha'), { key: 'Enter', altKey: true });
		expect(onReorder).not.toHaveBeenCalled();
	});
});

describe('enabled gate', () => {
	test('a disabled rail neither drags nor responds to the keyboard', () => {
		const onReorder = vi.fn();
		const onItemClick = vi.fn();
		const { getByTestId } = render(
			<Harness onReorder={onReorder} onItemClick={onItemClick} enabled={false} />,
		);

		mouseDrag(getByTestId('wrapper-alpha'), PITCH * 2);
		fireEvent.keyDown(getByTestId('wrapper-alpha'), { key: 'ArrowDown', altKey: true });

		expect(onReorder).not.toHaveBeenCalled();
		// …and an ordinary click still reaches the link underneath.
		fireEvent.click(getByTestId('item-alpha'));
		expect(onItemClick).toHaveBeenCalledWith('alpha');
	});
});

describe('item props', () => {
	test('native dragging is suppressed, since rail items are anchors', () => {
		const { getByTestId } = render(<Harness onReorder={vi.fn()} />);
		const wrapper = getByTestId('wrapper-alpha');

		expect(wrapper.getAttribute('draggable')).toBe('false');
		// Chromium's link-drag would otherwise hijack the gesture and cancel it.
		const dragStart = new Event('dragstart', { bubbles: true, cancelable: true });
		fireEvent(wrapper, dragStart);
		expect(dragStart.defaultPrevented).toBe(true);
	});

	test('only the lifted item takes touch-action away from the scrolling rail', () => {
		const { getByTestId } = render(<Harness onReorder={vi.fn()} />);
		expect(getByTestId('wrapper-alpha').style.touchAction).toBe('manipulation');

		mouseDrag(getByTestId('wrapper-alpha'), PITCH, { release: false });
		expect(getByTestId('wrapper-alpha').style.touchAction).toBe('none');
		expect(getByTestId('wrapper-beta').style.touchAction).toBe('manipulation');
	});
});

describe('click suppression cannot get stuck', () => {
	test('a drop with no synthesized click does not swallow the next press click', () => {
		const onReorder = vi.fn();
		const onItemClick = vi.fn();
		const { getByTestId } = render(<Harness onReorder={onReorder} onItemClick={onItemClick} />);

		// A real drag arms the suppression, but no click follows (released over dead space).
		mouseDrag(getByTestId('wrapper-alpha'), PITCH);
		expect(onReorder).toHaveBeenCalledWith(0, 1);

		// A fresh press must clear the stale flag so this click lands.
		fireEvent(getByTestId('wrapper-beta'), pointerEvent('pointerdown', { clientY: 0 }));
		fireEvent(document, pointerEvent('pointerup', { clientY: 0 }));
		fireEvent.click(getByTestId('item-beta'));
		expect(onItemClick).toHaveBeenCalledWith('beta');
	});
});
