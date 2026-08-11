/**
 * Page foreground/background - the one Page Lifecycle signal the socket layer needs.
 *
 * A mobile OS freezes a backgrounded PWA: timers stop and the WebSocket dies, so the
 * app returns to a dead socket it never saw close. Both halves of the recovery key off
 * the return to the foreground - the client redials at once (`lib/ws.ts`) and the
 * disconnect indicator holds its fire (`hooks/use-connection-status.ts`) - so the
 * subscription lives here once rather than being written twice.
 */

/**
 * True when the page is backgrounded. An environment without the API reads as visible,
 * never hidden, so a missing implementation can't fake a resume that never happened.
 */
export function isPageHidden(): boolean {
	return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/**
 * Call `onChange` whenever the page crosses between foreground and background.
 *
 * Reports genuine transitions only. `visibilitychange` and `pageshow` can both fire on
 * a single resume, and a duplicate "visible" would tear down the dial the first one had
 * just started. The exception is a `pageshow` restoring from bfcache, which always
 * reports: that can arrive with no preceding hidden transition to compare against.
 */
export function subscribeToPageVisibility(onChange: (hidden: boolean) => void): () => void {
	if (typeof document === 'undefined') return () => {};

	let lastHidden = isPageHidden();

	const report = (force: boolean) => {
		const hidden = isPageHidden();
		if (!force && hidden === lastHidden) return;
		lastHidden = hidden;
		onChange(hidden);
	};

	const onVisibilityChange = () => report(false);
	const onPageShow = (event: Event) => report((event as PageTransitionEvent).persisted);

	document.addEventListener('visibilitychange', onVisibilityChange);
	window.addEventListener('pageshow', onPageShow);
	return () => {
		document.removeEventListener('visibilitychange', onVisibilityChange);
		window.removeEventListener('pageshow', onPageShow);
	};
}
