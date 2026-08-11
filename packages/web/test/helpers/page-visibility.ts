/**
 * Drive the page between foreground and background in a component test.
 *
 * happy-dom defines `visibilityState` as a prototype getter that returns `visible`
 * whenever a window exists, so it can't be assigned or spied directly - shadow it with
 * an own property on the document and dispatch the event ourselves. Always pair with
 * `restorePageVisibility()` in an `afterEach`, which deletes the shadow and hands the
 * prototype getter back.
 */
export function setPageHidden(hidden: boolean): void {
	Object.defineProperty(document, 'visibilityState', {
		configurable: true,
		get: () => (hidden ? 'hidden' : 'visible'),
	});
	document.dispatchEvent(new Event('visibilitychange'));
}

export function restorePageVisibility(): void {
	delete (document as unknown as { visibilityState?: unknown }).visibilityState;
}
