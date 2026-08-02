// Minimal, cache-less service worker.
//
// Its purpose is to make Hezo *installable* as a PWA: Chrome/Android only
// fire `beforeinstallprompt` (and offer "Add to Home Screen") when a page has a
// valid manifest AND a service worker with a `fetch` handler. This worker
// satisfies that criterion while doing **no caching at all** - every request
// goes to the network. That keeps it from ever serving a stale app shell, which
// matters because Hezo's binary can self-update and restart; a caching SW could
// pin clients to an old build. If real offline support is ever wanted, add a
// cache strategy here deliberately.
//
// It does do one thing beyond passing requests through: it retries a failed
// *navigation*. Launching an installed PWA from the home screen starts the
// document request the instant the app opens, which on a phone routinely beats
// the radio waking from idle (or a VPN finishing its reconnect). That first
// request fails, and because a rejected `respondWith` is terminal, the launch
// lands on the browser's "This site can't be reached" (ERR_FAILED) page even
// though the network comes up a moment later. Retrying briefly turns that into
// the app simply opening.

/**
 * Delays before each navigation retry, in ms. The first attempt is immediate;
 * a launch that never reaches the network therefore fails after ~1.6s rather
 * than instantly, which is the deliberate trade for surviving a radio wake.
 */
const NAVIGATION_RETRY_DELAYS_MS = [400, 1200];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Fetches a navigation request, retrying on network failure.
 *
 * Only a rejected `fetch` is retried - that is a transport failure (the request
 * never landed). An HTTP error status is a real answer from a reachable server
 * and is passed straight through, so a 404 or a 500 still renders normally
 * instead of being retried into a delay.
 */
async function fetchNavigation(request) {
	let lastError;
	for (let attempt = 0; attempt <= NAVIGATION_RETRY_DELAYS_MS.length; attempt++) {
		if (attempt > 0) await sleep(NAVIGATION_RETRY_DELAYS_MS[attempt - 1]);
		try {
			return await fetch(request);
		} catch (err) {
			lastError = err;
		}
	}
	// Out of attempts: rethrow so the browser shows its own network error page.
	throw lastError;
}

self.addEventListener('install', () => {
	// Activate this worker immediately rather than waiting for old clients to close.
	self.skipWaiting();
});

self.addEventListener('activate', (event) => {
	// Take control of already-open pages so the fetch handler is in effect at once.
	event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
	// Navigations are the launch path, and the only thing worth intercepting.
	if (event.request.mode === 'navigate') {
		event.respondWith(fetchNavigation(event.request));
		return;
	}
	// Everything else falls through to the browser's own networking untouched.
	// Answering these with `respondWith(fetch(...))` would add no behaviour while
	// converting every transient blip into a hard failure the browser can no
	// longer handle itself. The listener still exists, which is what
	// installability actually requires.
});
