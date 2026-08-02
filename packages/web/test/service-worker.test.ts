/**
 * Guards the PWA service worker's navigation handling.
 *
 * The fault this covers shipped: the worker answered every request with a bare
 * `event.respondWith(fetch(event.request))`. A rejected `respondWith` is
 * terminal, so the one transient failure that a home-screen launch reliably
 * produces - the document request beating the phone's radio out of idle - put
 * the launch on the browser's ERR_FAILED page instead of in the app.
 *
 * `public/sw.js` never runs under vitest (it is a worker script served as-is),
 * so it is evaluated here against a stub global scope. That keeps the assertions
 * on the committed file rather than on a re-implementation of it.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

type FetchEvent = {
	request: { mode: string };
	respondWith: (response: Promise<unknown>) => void;
};

const SW_SOURCE = readFileSync(resolve(__dirname, '../public/sw.js'), 'utf8');

/**
 * Evaluates the committed worker against a stub `self`, returning its handlers.
 *
 * `setTimeout` is stubbed to fire immediately so the retry backoff does not put
 * its real ~1.6s into the suite; the assertions are about attempt counts and
 * ordering, not wall-clock delay.
 */
function loadServiceWorker(fetchImpl: (request: unknown) => Promise<unknown>) {
	const handlers: Record<string, (event: unknown) => void> = {};
	const lifecycle = { skipWaiting: 0, claim: 0 };
	const scope = {
		addEventListener: (type: string, fn: (event: unknown) => void) => {
			handlers[type] = fn;
		},
		skipWaiting: () => {
			lifecycle.skipWaiting++;
		},
		clients: {
			claim: () => {
				lifecycle.claim++;
				return Promise.resolve();
			},
		},
	};
	const immediateTimeout = (fn: () => void) => {
		fn();
		return 0;
	};
	new Function('self', 'fetch', 'setTimeout', SW_SOURCE)(scope, fetchImpl, immediateTimeout);
	return { handlers, lifecycle };
}

/** Drives the fetch handler and returns what it answered with, if anything. */
function dispatchFetch(
	handlers: Record<string, (event: unknown) => void>,
	mode: string,
): Promise<unknown> | null {
	let answered: Promise<unknown> | null = null;
	const event: FetchEvent = {
		request: { mode },
		respondWith: (response) => {
			answered = response;
		},
	};
	handlers.fetch(event);
	return answered;
}

describe('service worker navigation handling', () => {
	test('a navigation that fails once still lands in the app', async () => {
		// The reported bug, exactly: the launch request loses the race with the
		// radio, the retry a moment later succeeds.
		const ok = { status: 200 };
		let calls = 0;
		const { handlers } = loadServiceWorker(async () => {
			calls++;
			if (calls === 1) throw new TypeError('Failed to fetch');
			return ok;
		});

		await expect(dispatchFetch(handlers, 'navigate')).resolves.toBe(ok);
		expect(calls).toBe(2);
	});

	test('a navigation that succeeds first time is not delayed by a retry', async () => {
		const ok = { status: 200 };
		let calls = 0;
		const { handlers } = loadServiceWorker(async () => {
			calls++;
			return ok;
		});

		await expect(dispatchFetch(handlers, 'navigate')).resolves.toBe(ok);
		expect(calls).toBe(1);
	});

	test('a genuinely offline navigation gives up so the browser can show its error', async () => {
		let calls = 0;
		const { handlers } = loadServiceWorker(async () => {
			calls++;
			throw new TypeError('Failed to fetch');
		});

		await expect(dispatchFetch(handlers, 'navigate')).rejects.toThrow('Failed to fetch');
		// Bounded: the initial attempt plus the two configured retries.
		expect(calls).toBe(3);
	});

	test('an HTTP error status is passed through rather than retried', async () => {
		// A 500 is a real answer from a reachable server. Retrying it would just
		// delay the error the app should render.
		const serverError = { status: 500 };
		let calls = 0;
		const { handlers } = loadServiceWorker(async () => {
			calls++;
			return serverError;
		});

		await expect(dispatchFetch(handlers, 'navigate')).resolves.toBe(serverError);
		expect(calls).toBe(1);
	});

	test('non-navigation requests are left to the browser', async () => {
		// Intercepting these adds no behaviour and takes the browser's own
		// handling away from it, which is what made a blip terminal.
		let calls = 0;
		const { handlers } = loadServiceWorker(async () => {
			calls++;
			return { status: 200 };
		});

		expect(dispatchFetch(handlers, 'cors')).toBe(null);
		expect(dispatchFetch(handlers, 'no-cors')).toBe(null);
		expect(calls).toBe(0);
	});

	test('the worker still registers a fetch listener, which installability requires', () => {
		const { handlers } = loadServiceWorker(async () => ({ status: 200 }));
		expect(typeof handlers.fetch).toBe('function');
		expect(typeof handlers.install).toBe('function');
		expect(typeof handlers.activate).toBe('function');
	});

	test('it takes control of open pages immediately on activate', async () => {
		// skipWaiting + claim are what let a freshly deployed worker apply to the
		// tab that is already open, rather than waiting for every client to close.
		const { handlers, lifecycle } = loadServiceWorker(async () => ({ status: 200 }));

		handlers.install({});
		expect(lifecycle.skipWaiting).toBe(1);

		let waited: Promise<unknown> | null = null;
		handlers.activate({
			waitUntil: (p: Promise<unknown>) => {
				waited = p;
			},
		});
		expect(waited).not.toBe(null);
		await waited;
		expect(lifecycle.claim).toBe(1);
	});
});
