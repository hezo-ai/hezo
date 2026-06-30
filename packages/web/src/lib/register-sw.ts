/**
 * Registers the PWA service worker (`/sw.js`). Required for the app to satisfy
 * the browser's installability criteria — see `public/sw.js` for why the worker
 * itself does no caching.
 *
 * Best-effort and side-effect-only: guarded so it's a no-op where service
 * workers are unavailable (older browsers, non-secure contexts, and the
 * happy-dom test environment, where `navigator.serviceWorker` is undefined).
 */
export function registerServiceWorker(): void {
	if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
	// Defer until after load so registration never competes with first paint.
	window.addEventListener('load', () => {
		navigator.serviceWorker.register('/sw.js').catch(() => {
			// Registration failures (insecure origin, disabled SW) just mean no
			// install prompt — not a user-facing error.
		});
	});
}
