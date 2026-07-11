import { useEffect, useRef, useState } from 'react';

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
	// Handle of the in-flight rAF-driven scroll animation, so a repeat click or an
	// unmount can cancel it instead of leaving two animations fighting.
	const frameRef = useRef<number | null>(null);
	useEffect(() => {
		if (!scrollParent) return;
		const check = () => setAtTop(scrollParent.scrollTop <= 200);
		check();
		scrollParent.addEventListener('scroll', check, { passive: true });
		return () => scrollParent.removeEventListener('scroll', check);
	}, [scrollParent]);

	// Stop any running animation when the scroller changes or the shell unmounts.
	useEffect(
		() => () => {
			if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
		},
		[],
	);

	const scrollToTop = () => {
		const el = scrollParent;
		if (!el) return;
		if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);

		// Native `scrollTo({ behavior: 'smooth' })` on a nested overflow container is
		// unreliable on mobile: when the viewport height changes mid-animation — which
		// mobile browsers do routinely as the URL bar collapses/expands while the page
		// moves — WebKit aborts the smooth scroll partway, stranding the user short of
		// the top and forcing a second tap. Drive the animation ourselves with rAF,
		// writing `scrollTop` each frame, so it always lands at exactly 0 regardless of
		// viewport churn.
		const start = el.scrollTop;
		const prefersReducedMotion =
			typeof window !== 'undefined' &&
			window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
		if (start <= 0 || prefersReducedMotion) {
			el.scrollTop = 0;
			frameRef.current = null;
			return;
		}

		// Snappy but proportional: ~0.5ms per pixel, clamped to a 200–600ms window.
		const duration = Math.min(600, Math.max(200, start * 0.5));
		const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
		let startTime: number | null = null;
		const step = (now: number) => {
			if (startTime === null) startTime = now;
			const t = Math.min(1, (now - startTime) / duration);
			el.scrollTop = Math.round(start * (1 - easeOutCubic(t)));
			if (t < 1) {
				frameRef.current = requestAnimationFrame(step);
			} else {
				el.scrollTop = 0;
				frameRef.current = null;
			}
		};
		frameRef.current = requestAnimationFrame(step);
	};

	return { atTop, scrollToTop };
}
