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
	// One effect does both jobs so they stay in lockstep, re-running on every
	// caller-supplied signal in `deps`. `deps` must therefore include whatever
	// gates the textarea's presence (e.g. a panel's `open`, or an `expanded`
	// flag) — the element mounts *after* the component in those cases, so the
	// observer has to (re)attach when that signal flips, not just on first mount.
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		// Disabled: something else owns the height (a `flex-1` fill), so drop any
		// inline height we set and attach no observer.
		if (!enabled) {
			el.style.height = '';
			return;
		}
		// Grow/shrink to the current content, then keep it right as the width
		// changes. The content height depends on the textarea's *width* too: a
		// container resize, a viewport breakpoint change, or a web font swapping in
		// all re-wrap the text, and without re-measuring the box keeps a stale
		// height — too tall after it widens, or clipping the top line after it
		// narrows. The `clientWidth === lastWidth` guard keeps our own height writes
		// (which don't change width) from feeding back into a resize loop.
		fitTextareaToContent(el);
		if (typeof ResizeObserver === 'undefined') return;
		let lastWidth = el.clientWidth;
		const ro = new ResizeObserver(() => {
			if (el.clientWidth === lastWidth) return;
			lastWidth = el.clientWidth;
			fitTextareaToContent(el);
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, [ref, enabled, ...deps]);
}
