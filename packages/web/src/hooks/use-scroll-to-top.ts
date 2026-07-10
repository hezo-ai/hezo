import { useEffect, useState } from 'react';

/**
 * Companion to `useScrollToBottom` for the "jump to top" affordance. `atTop`
 * depends only on `scrollTop` (never on `scrollHeight`), so unlike the bottom
 * hook this needs no Resize/Mutation observers — a plain scroll listener plus an
 * initial measurement is enough. Content growth can't change whether you're at
 * the top; only scrolling can.
 */
export function useScrollToTop(scrollParent: HTMLElement | null): {
	atTop: boolean;
	scrollToTop: () => void;
} {
	// Start hidden (`atTop: true`) so short pages never flash the button before the
	// first measurement runs — mirrors `useScrollToBottom`'s initial state.
	const [atTop, setAtTop] = useState(true);
	useEffect(() => {
		if (!scrollParent) return;
		const check = () => setAtTop(scrollParent.scrollTop <= 200);
		check();
		scrollParent.addEventListener('scroll', check, { passive: true });
		return () => scrollParent.removeEventListener('scroll', check);
	}, [scrollParent]);

	const scrollToTop = () => {
		scrollParent?.scrollTo({ top: 0, behavior: 'smooth' });
	};

	return { atTop, scrollToTop };
}
