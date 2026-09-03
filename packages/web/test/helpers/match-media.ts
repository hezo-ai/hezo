import { vi } from 'vitest';

/**
 * A controllable `matchMedia`, returning `matches` and capturing change listeners.
 *
 * Anything reaching `useTheme` reads `prefers-color-scheme`, which happy-dom does
 * not implement, so a spec that renders one has to supply this.
 */
export function installMatchMedia(matches: boolean) {
	const listeners = new Set<() => void>();
	const mql = {
		matches,
		media: '(prefers-color-scheme: dark)',
		onchange: null,
		addEventListener: (_type: string, cb: () => void) => listeners.add(cb),
		removeEventListener: (_type: string, cb: () => void) => listeners.delete(cb),
		addListener: (cb: () => void) => listeners.add(cb),
		removeListener: (cb: () => void) => listeners.delete(cb),
		dispatchEvent: () => true,
	};
	const spy = vi.spyOn(window, 'matchMedia').mockReturnValue(mql as unknown as MediaQueryList);
	return {
		spy,
		listeners,
		/** Flip the system preference and fire the captured change listeners. */
		setMatches(next: boolean) {
			mql.matches = next;
			for (const cb of listeners) cb();
		},
	};
}
