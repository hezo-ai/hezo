const pending = new Set<Promise<unknown>>();

/**
 * Register fire-and-forget work so shutdown (and every test's teardown) can
 * drain it before closing the database out from under it.
 *
 * The cleanup deliberately does not use `promise.finally(...)`: that returns a
 * *new* promise which adopts the original's rejection, and discarding it makes
 * a rejecting tracked promise surface as an `unhandledRejection` even when the
 * caller handled the original. Attaching with `then(cb, cb)` and swallowing the
 * derived branch keeps the caller's own handling authoritative.
 */
export function trackBackground<T>(promise: Promise<T>): Promise<T> {
	pending.add(promise);
	const untrack = () => {
		pending.delete(promise);
	};
	promise.then(untrack, untrack);
	return promise;
}

export async function waitForBackground(): Promise<void> {
	while (pending.size > 0) {
		await Promise.allSettled(Array.from(pending));
	}
}
