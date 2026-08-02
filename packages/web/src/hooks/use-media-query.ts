import { useEffect, useState } from 'react';

/**
 * Reactive `window.matchMedia` — re-renders when the query flips. Guards for
 * environments without `matchMedia`, where it always reports `false`.
 *
 * Note happy-dom is NOT such an environment: it implements `matchMedia` and
 * reports a 1024px-wide viewport, so component tests evaluate every query
 * against that width and land on the desktop side of a `min-width` breakpoint.
 * Behaviour that differs by breakpoint needs a Playwright spec at the viewport
 * in question, not a component test that assumes mobile.
 */
export function useMediaQuery(query: string): boolean {
	const [matches, setMatches] = useState(() => {
		if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
		return window.matchMedia(query).matches;
	});
	useEffect(() => {
		if (typeof window.matchMedia !== 'function') return;
		const mql = window.matchMedia(query);
		const onChange = () => setMatches(mql.matches);
		mql.addEventListener?.('change', onChange);
		setMatches(mql.matches);
		return () => mql.removeEventListener?.('change', onChange);
	}, [query]);
	return matches;
}
