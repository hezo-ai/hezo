// Unit tests for ResizableSplit: the divider's a11y contract, the collapsed vs
// default vs dragged track classes, and that dragging / arrow-keys drive the
// width state, the `--panel-w` CSS variable, and persistence. happy-dom has no
// layout, so getBoundingClientRect is stubbed to a fixed width to make the clamp
// math deterministic; real pixel behavior is covered by
// test/browser/task-doc-preview-resize.spec.ts.
import { fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ResizableSplit } from '../src/components/ui/resizable-split';

const KEY = 'hezo:test-resizable-split';
const DEFAULT_TRACK = 'lg:grid-cols-[1fr_360px] xl:grid-cols-[1fr_520px] 2xl:grid-cols-[1fr_720px]';
const COLLAPSED_TRACK = 'lg:grid-cols-[1fr_190px]';
const VAR_TRACK = 'lg:grid-cols-[1fr_var(--panel-w)]';

/** happy-dom returns zero-size boxes; pin a width so clamp math is predictable. */
function stubLayout(width: number) {
	vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
		width,
		height: 0,
		top: 0,
		left: 0,
		right: width,
		bottom: 0,
		x: 0,
		y: 0,
		toJSON: () => ({}),
	} as DOMRect);
}

/** Synthesize a pointer event as a MouseEvent carrying the fields the hook reads. */
function pointerEvent(type: string, init: { clientX: number; pointerId?: number }): MouseEvent {
	const e = new MouseEvent(type, {
		bubbles: true,
		cancelable: true,
		clientX: init.clientX,
		clientY: 0,
		button: 0,
	});
	Object.assign(e, { pointerId: init.pointerId ?? 1, isPrimary: true });
	return e;
}

beforeEach(() => localStorage.clear());
afterEach(() => {
	vi.restoreAllMocks();
	localStorage.clear();
});

test('renders an accessible resize handle and the default track when a panel is present', () => {
	const { getByTestId, container } = render(
		<ResizableSplit panel={<div>panel</div>} defaultTrackClass={DEFAULT_TRACK} storageKey={KEY}>
			<div>main</div>
		</ResizableSplit>,
	);
	const handle = getByTestId('resize-handle');
	expect(handle.getAttribute('role')).toBe('separator');
	expect(handle.getAttribute('aria-orientation')).toBe('vertical');
	expect(handle.getAttribute('aria-label')).toBe('Resize panel');
	expect(handle.tabIndex).toBe(0);

	const grid = container.firstElementChild as HTMLElement;
	expect(grid.className).toContain(DEFAULT_TRACK);
	expect(grid.className).not.toContain('var(--panel-w)');
	expect(grid.style.getPropertyValue('--panel-w')).toBe('');
});

test('omits the handle and uses the collapsed track when panel is null', () => {
	const { queryByTestId, container } = render(
		<ResizableSplit
			panel={null}
			defaultTrackClass={DEFAULT_TRACK}
			collapsedTrackClass={COLLAPSED_TRACK}
			storageKey={KEY}
		>
			<div>main</div>
		</ResizableSplit>,
	);
	expect(queryByTestId('resize-handle')).toBeNull();
	const grid = container.firstElementChild as HTMLElement;
	expect(grid.className).toContain(COLLAPSED_TRACK);
	expect(grid.className).not.toContain('360px');
});

test('dragging the divider updates the width, sets the CSS var, and persists', () => {
	stubLayout(800); // cell + container both measure 800 (range → [280, 420])
	const { getByTestId, container } = render(
		<ResizableSplit
			panel={<div>panel</div>}
			side="right"
			defaultTrackClass={DEFAULT_TRACK}
			storageKey={KEY}
		>
			<div>main</div>
		</ResizableSplit>,
	);
	const handle = getByTestId('resize-handle');
	// Drag right by 400px → on the right side that narrows: 800 − 400 = 400 (in range).
	fireEvent(handle, pointerEvent('pointerdown', { clientX: 500 }));
	fireEvent(document, pointerEvent('pointermove', { clientX: 900 }));
	fireEvent(document, pointerEvent('pointerup', { clientX: 900 }));

	const grid = container.firstElementChild as HTMLElement;
	expect(grid.style.getPropertyValue('--panel-w')).toBe('400px');
	expect(grid.className).toContain(VAR_TRACK);
	expect(localStorage.getItem(KEY)).toBe('400');
});

test('arrow keys resize the focused handle by a step and persist (right side: ← widens)', () => {
	stubLayout(800); // range → [280, 420]
	localStorage.setItem(KEY, '350'); // start inside the range
	const { getByTestId, container } = render(
		<ResizableSplit
			panel={<div>panel</div>}
			side="right"
			defaultTrackClass={DEFAULT_TRACK}
			storageKey={KEY}
		>
			<div>main</div>
		</ResizableSplit>,
	);
	const grid = container.firstElementChild as HTMLElement;
	expect(grid.style.getPropertyValue('--panel-w')).toBe('350px');

	const handle = getByTestId('resize-handle');
	fireEvent.keyDown(handle, { key: 'ArrowLeft' }); // toward main → widen by STEP(24)
	expect(grid.style.getPropertyValue('--panel-w')).toBe('374px');
	expect(localStorage.getItem(KEY)).toBe('374');

	fireEvent.keyDown(handle, { key: 'ArrowRight' }); // away from main → narrow by STEP
	expect(grid.style.getPropertyValue('--panel-w')).toBe('350px');
	expect(localStorage.getItem(KEY)).toBe('350');
});
