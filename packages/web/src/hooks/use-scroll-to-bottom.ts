import { useEffect, useState } from 'react';

// How long the pill lingers after the last downward scroll before hiding.
// Continuous scrolling keeps restarting this countdown; a pause fades it out.
const HIDE_AFTER_IDLE_MS = 2000;
// Within this many pixels of the bottom we treat the scroller as "at the very
// bottom": there is nothing further to jump to, so the pill never shows.
const AT_BOTTOM_THRESHOLD = 8;

export function useScrollToBottom(scrollParent: HTMLElement | null): {
	visible: boolean;
	scrollToBottom: () => void;
} {
	// Start hidden: the pill only ever appears in response to a downward scroll.
	const [visible, setVisible] = useState(false);
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
		const atBottom = () =>
			scrollParent.scrollTop + scrollParent.clientHeight >=
			scrollParent.scrollHeight - AT_BOTTOM_THRESHOLD;
		const onScroll = () => {
			const current = scrollParent.scrollTop;
			const delta = current - lastScrollTop;
			lastScrollTop = current;
			// Already at the very bottom — nothing further to jump to, so never show.
			if (atBottom()) {
				clearHideTimer();
				setVisible(false);
				return;
			}
			if (delta > 0) {
				// Scrolling down: reveal and (re)start the idle countdown.
				setVisible(true);
				clearHideTimer();
				hideTimer = setTimeout(() => {
					hideTimer = null;
					setVisible(false);
				}, HIDE_AFTER_IDLE_MS);
			} else if (delta < 0) {
				// Scrolling up is the opposite intent — hide immediately.
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

	const scrollToBottom = () => {
		if (!scrollParent) return;
		const target = scrollParent;
		target.scrollTo({ top: target.scrollHeight, behavior: 'smooth' });
		// Lazy virtualised content keeps growing scrollHeight as new rows render,
		// so re-anchor at the bottom until the height stops changing or the budget runs out.
		const deadline = Date.now() + 5000;
		let lastScrollHeight = -1;
		let stableTicks = 0;
		const tick = () => {
			target.scrollTo({ top: target.scrollHeight, behavior: 'auto' });
			if (target.scrollHeight === lastScrollHeight) {
				stableTicks++;
				if (stableTicks >= 3) return;
			} else {
				lastScrollHeight = target.scrollHeight;
				stableTicks = 0;
			}
			if (Date.now() >= deadline) return;
			setTimeout(tick, 100);
		};
		setTimeout(tick, 400);
	};

	return { visible, scrollToBottom };
}
