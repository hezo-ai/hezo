import { useLocation } from '@tanstack/react-router';
import { useCallback, useRef } from 'react';

/**
 * Returns a ref callback that scrolls its element into view when the current
 * router hash matches `id`. Because the callback fires when the element mounts —
 * which, on a page whose content loads from an async query, happens after the
 * initial render — a cross-page deep link (e.g. `…/settings#budget`) still lands
 * on the section even though it isn't in the DOM at navigation time. Guarded to
 * fire once per hash so a later re-render never yanks the viewport back.
 */
export function useScrollToHash(id: string) {
	const hash = useLocation({ select: (l) => l.hash });
	const scrolledFor = useRef<string | null>(null);
	return useCallback(
		(el: HTMLElement | null) => {
			// `location.hash` has no leading '#'.
			if (!el || hash !== id || scrolledFor.current === id) return;
			scrolledFor.current = id;
			el.scrollIntoView({ behavior: 'smooth', block: 'start' });
		},
		[hash, id],
	);
}
