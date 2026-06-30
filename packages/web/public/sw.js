// Minimal, network-only service worker.
//
// Its sole purpose is to make Hezo *installable* as a PWA: Chrome/Android only
// fire `beforeinstallprompt` (and offer "Add to Home Screen") when a page has a
// valid manifest AND a service worker with a `fetch` handler. This worker
// satisfies that criterion while doing **no caching at all** — every request
// goes straight to the network. That keeps it from ever serving a stale app
// shell, which matters because Hezo's binary can self-update and restart; a
// caching SW could pin clients to an old build. If real offline support is ever
// wanted, add a cache strategy here deliberately.

self.addEventListener('install', () => {
	// Activate this worker immediately rather than waiting for old clients to close.
	self.skipWaiting();
});

self.addEventListener('activate', (event) => {
	// Take control of already-open pages so the fetch handler is in effect at once.
	event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
	// Network-only passthrough. Present purely so the app meets PWA install
	// criteria — intentionally no cache reads or writes.
	event.respondWith(fetch(event.request));
});
