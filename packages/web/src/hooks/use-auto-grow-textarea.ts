import { type DependencyList, type RefObject, useEffect } from 'react';

/** Grow/shrink a textarea to fit its content, capped by its CSS `max-height`. */
export function fitTextareaToContent(el: HTMLTextAreaElement): void {
	el.style.height = 'auto';
	el.style.height = `${el.scrollHeight}px`;
}

/**
 * Auto-size a textarea to its content: it grows with the text (capped by the
 * element's CSS `max-height`, past which it scrolls) and shrinks back down as
 * content is removed. Extracted from the CEO chat composer so the task-comment
 * composer can reuse the exact behaviour.
 *
 * Pass `enabled = false` when something else owns the height (e.g. a `flex-1`
 * fill in a fullscreen layout) — the hook then clears any inline height it set
 * so the flex rule can take over.
 *
 * @param ref     the textarea to size
 * @param deps    values that, when changed, should re-measure (typically the
 *                controlled value, plus any mount/visibility signal)
 * @param enabled auto-size while true; clear inline height while false
 */
export function useAutoGrowTextarea(
	ref: RefObject<HTMLTextAreaElement | null>,
	deps: DependencyList,
	enabled = true,
): void {
	// Re-fit when the content (or another caller-supplied signal) changes, and
	// collapse back to a single row when it is cleared. When disabled we drop the
	// inline height so a `flex-1` fill height is not overridden.
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		if (!enabled) {
			el.style.height = '';
			return;
		}
		fitTextareaToContent(el);
	}, [ref, enabled, ...deps]);

	// The content height also depends on the textarea's *width*: a container
	// resize, a viewport breakpoint change, or a web font swapping in all re-wrap
	// the text. Without re-measuring on those, the box keeps a stale height — too
	// tall after it widens, or clipping the top line after it narrows. A
	// ResizeObserver re-fits on any width change; the guard keeps our own height
	// writes (which don't change width) from feeding back into a resize loop.
	useEffect(() => {
		const el = ref.current;
		if (!el || !enabled || typeof ResizeObserver === 'undefined') return;
		let lastWidth = el.clientWidth;
		const ro = new ResizeObserver(() => {
			if (el.clientWidth === lastWidth) return;
			lastWidth = el.clientWidth;
			fitTextareaToContent(el);
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, [ref, enabled]);
}
