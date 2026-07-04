import { useEffect, useState } from 'react';

export function useScrollToBottom(scrollParent: HTMLElement | null): {
	atBottom: boolean;
	scrollToBottom: () => void;
} {
	// Start hidden (`atBottom: true`) so short pages never flash the button
	// before the first measurement runs.
	const [atBottom, setAtBottom] = useState(true);
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
		const observeChildren = () => {
			for (const child of Array.from(scrollParent.children)) ro.observe(child);
		};
		observeChildren();
		// The scroll parent can outlive its content: the shell <main> never
		// unmounts across navigations — the route swap replaces its children. The
		// ResizeObserver only tracks the elements it was handed, so re-observe (a
		// no-op for already-observed nodes) and re-measure whenever the child list
		// changes; otherwise the new page's async content growth goes unseen and
		// the button state is stale until the next scroll.
		const mo = new MutationObserver(() => {
			observeChildren();
			check();
		});
		mo.observe(scrollParent, { childList: true });
		return () => {
			scrollParent.removeEventListener('scroll', check);
			mo.disconnect();
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
