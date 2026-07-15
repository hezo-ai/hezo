import { createContext, useContext } from 'react';

/**
 * Lets a route tell the app shell which DOM element is its scrollable content
 * pane, so the shell can horizontally centre the global scroll-to-top/bottom
 * pills over *that* pane rather than over the full <main> width. This matters on
 * pages whose <main> also holds a non-scrolling side panel (e.g. the task
 * detail meta rail): centring over the whole width drifts the pills off to the
 * right, over the panel. Routes with no side panel simply don't register, and
 * the pills fall back to centring over <main>.
 *
 * The value is a stable callback the route attaches as a `ref` to its content
 * wrapper; React calls it with the element on mount and `null` on unmount.
 */
export const ScrollContentContext = createContext<(el: HTMLElement | null) => void>(() => {});

/** A stable callback ref a route attaches to its scrollable content pane. */
export function useRegisterScrollContent(): (el: HTMLElement | null) => void {
	return useContext(ScrollContentContext);
}
