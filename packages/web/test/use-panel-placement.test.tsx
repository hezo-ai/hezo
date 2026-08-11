// Unit tests for usePanelPlacement: the wiring around the placement math —
// which side it reports, that it stays inert (and un-thrashed) in a layout-less
// environment, that it survives a missing ResizeObserver, and that every
// listener it adds is removed on close and unmount.
//
// happy-dom has no layout, so every rect is zero and the resolved side is
// deterministic here; the arithmetic itself is covered in panel-placement.test.ts
// and real pixels in test/browser/dropdown-flip-placement.mobile.spec.ts.
import { cleanup, fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { usePanelPlacement } from '../src/hooks/use-panel-placement';
import type { PanelSide } from '../src/lib/panel-placement';

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

interface HarnessProps {
	open?: boolean;
	prefer?: PanelSide;
	preferredMaxHeight?: number;
	/** Mutated in the render body so a test can count renders. */
	renders?: { count: number };
}

function Harness({ open = true, prefer, preferredMaxHeight, renders }: HarnessProps) {
	const anchorRef = useRef<HTMLDivElement>(null);
	const { panelRef, side, sideClassName, style } = usePanelPlacement<HTMLDivElement>(anchorRef, {
		open,
		prefer,
		preferredMaxHeight,
	});
	if (renders) renders.count += 1;
	return (
		<div ref={anchorRef} data-testid="anchor">
			{open && (
				<div
					ref={panelRef}
					data-testid="panel"
					data-placement={side}
					className={sideClassName}
					style={style}
				/>
			)}
		</div>
	);
}

describe('resolved side', () => {
	test('defaults to below the anchor', () => {
		// The pre-existing behaviour of every panel this hook replaces: with no
		// layout to contradict it, nothing moves.
		const { getByTestId } = render(<Harness />);
		const panel = getByTestId('panel');
		expect(panel.getAttribute('data-placement')).toBe('bottom');
		expect(panel.className).toBe('top-full mt-1');
	});

	test('honours a preferred side of top', () => {
		const { getByTestId } = render(<Harness prefer="top" />);
		const panel = getByTestId('panel');
		expect(panel.getAttribute('data-placement')).toBe('top');
		expect(panel.className).toBe('bottom-full mb-1');
	});

	test('applies a height cap as an inline style', () => {
		const { getByTestId } = render(<Harness />);
		expect(getByTestId('panel').style.maxHeight).not.toBe('');
	});
});

describe('measurement wiring', () => {
	test('does not throw when ResizeObserver is unavailable', () => {
		// The guard is load-bearing: the web test setup stubs IntersectionObserver
		// but not ResizeObserver, and older mobile browsers can lack it too.
		const globals = globalThis as { ResizeObserver?: typeof ResizeObserver };
		const original = globals.ResizeObserver;
		globals.ResizeObserver = undefined;
		try {
			expect(() => render(<Harness />)).not.toThrow();
		} finally {
			globals.ResizeObserver = original;
		}
	});

	test('stays stable across repeated resize and scroll events', () => {
		// Re-measuring must converge, not oscillate: the cap the hook writes can't
		// move the content height it reads back, so identical geometry has to
		// produce an identical placement however many times it is measured. A
		// regression here shows up as a panel flickering between sides on scroll.
		const renders = { count: 0 };
		const { getByTestId } = render(<Harness renders={renders} />);
		const panel = getByTestId('panel');
		const side = panel.getAttribute('data-placement');
		const cap = panel.style.maxHeight;
		const before = renders.count;

		for (let i = 0; i < 5; i += 1) {
			fireEvent(window, new Event('resize'));
			fireEvent(document, new Event('scroll'));
		}

		expect(panel.getAttribute('data-placement')).toBe(side);
		expect(panel.style.maxHeight).toBe(cap);
		// React may re-render once per bail-out, but never more than once per event.
		expect(renders.count - before).toBeLessThanOrEqual(10);
	});

	test('attaches no listeners while closed', () => {
		const onWindow = vi.spyOn(window, 'addEventListener');
		const onDocument = vi.spyOn(document, 'addEventListener');
		render(<Harness open={false} />);
		expect(onWindow).not.toHaveBeenCalledWith('resize', expect.anything());
		expect(onDocument).not.toHaveBeenCalledWith('scroll', expect.anything(), expect.anything());
	});

	test('removes every listener it added on unmount', () => {
		const addWindow = vi.spyOn(window, 'addEventListener');
		const removeWindow = vi.spyOn(window, 'removeEventListener');
		const addDocument = vi.spyOn(document, 'addEventListener');
		const removeDocument = vi.spyOn(document, 'removeEventListener');

		const { unmount } = render(<Harness />);
		const resize = addWindow.mock.calls.find(([type]) => type === 'resize');
		const scroll = addDocument.mock.calls.find(([type]) => type === 'scroll');
		expect(resize).toBeDefined();
		expect(scroll).toBeDefined();

		unmount();
		// Same handler identity, or the listener outlives the panel.
		expect(removeWindow).toHaveBeenCalledWith('resize', resize?.[1]);
		expect(removeDocument).toHaveBeenCalledWith('scroll', scroll?.[1], { capture: true });
	});

	test('removes its listeners when the panel closes without unmounting', () => {
		const removeWindow = vi.spyOn(window, 'removeEventListener');
		const { rerender } = render(<Harness />);
		removeWindow.mockClear();
		rerender(<Harness open={false} />);
		expect(removeWindow).toHaveBeenCalledWith('resize', expect.anything());
	});
});
