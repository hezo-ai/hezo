import { useEffect, useState } from 'react';

export function useScrollToBottom(scrollParent: HTMLElement | null): {
	atBottom: boolean;
	scrollToBottom: () => void;
} {
	const [atBottom, setAtBottom] = useState(false);
	useEffect(() => {
		if (!scrollParent) return;
		const check = () => {
			setAtBottom(
				scrollParent.scrollTop + scrollParent.clientHeight >= scrollParent.scrollHeight - 200,
			);
		};
		check();
		scrollParent.addEventListener('scroll', check, { passive: true });
		const ro = new ResizeObserver(check);
		ro.observe(scrollParent);
		for (const child of Array.from(scrollParent.children)) ro.observe(child);
		return () => {
			scrollParent.removeEventListener('scroll', check);
			ro.disconnect();
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

	return { atBottom, scrollToBottom };
}
