import { useEffect, useState } from 'react';

/**
 * Reactive `window.matchMedia` — re-renders when the query flips. Guards for
 * environments without `matchMedia` (happy-dom in component tests), where it
 * always reports `false`.
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
