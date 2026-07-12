import { useEffect, useRef, useState } from 'react';

// How long the pill lingers after the last upward scroll before hiding itself.
// Every fresh upward scroll restarts this countdown, so continuous scrolling
// keeps it up; a pause of this long makes it fade out.
const HIDE_AFTER_IDLE_MS = 2000;
// Below this many pixels from the top we treat the scroller as "at the very
// top": there is nothing to jump to, so the pill never shows. Small (rather
// than the generous buffer the visibility check used to carry) so a genuine
// upward scroll that stops just short of the top still reveals the pill.
const AT_TOP_THRESHOLD = 4;

/**
 * Companion to `useScrollToBottom` for the "jump to top" affordance. The pill is
 * revealed only while the user is actively scrolling *up* and hides again a
 * couple of seconds after they stop (or the moment they reverse direction, or
 * reach the very top). Content growth can't change whether you're at the top —
 * only scrolling can — so a plain scroll listener with a per-direction idle
 * timer is all this needs; no Resize/Mutation observers.
 */
export function useScrollToTop(scrollParent: HTMLElement | null): {
	visible: boolean;
	scrollToTop: () => void;
} {
	// Start hidden: the pill only ever appears in response to an upward scroll.
	const [visible, setVisible] = useState(false);
	// Handle of the in-flight rAF-driven scroll animation, so a repeat click or an
	// unmount can cancel it instead of leaving two animations fighting.
	const frameRef = useRef<number | null>(null);

	useEffect(() => {
		if (!scrollParent) return;
		let lastScrollTop = scrollParent.scrollTop;
		let hideTimer: ReturnType<typeof setTimeout> | null = null;
		const clearHideTimer = () => {
			if (hideTimer !== null) {
				clearTimeout(hideTimer);
				hideTimer = null;
			}
		};
		const onScroll = () => {
			const current = scrollParent.scrollTop;
			const delta = current - lastScrollTop;
			lastScrollTop = current;
			// Already at the very top — nothing to jump to, so never show.
			if (current <= AT_TOP_THRESHOLD) {
				clearHideTimer();
				setVisible(false);
				return;
			}
			if (delta < 0) {
				// Scrolling up: reveal and (re)start the idle countdown.
				setVisible(true);
				clearHideTimer();
				hideTimer = setTimeout(() => {
					hideTimer = null;
					setVisible(false);
				}, HIDE_AFTER_IDLE_MS);
			} else if (delta > 0) {
				// Scrolling down is the opposite intent — hide immediately.
				clearHideTimer();
				setVisible(false);
			}
		};
		scrollParent.addEventListener('scroll', onScroll, { passive: true });
		return () => {
			scrollParent.removeEventListener('scroll', onScroll);
			clearHideTimer();
		};
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

	return { visible, scrollToTop };
}
