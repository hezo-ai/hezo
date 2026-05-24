const pending = new Set<Promise<unknown>>();

export function trackBackground<T>(promise: Promise<T>): Promise<T> {
	pending.add(promise);
	promise.finally(() => {
		pending.delete(promise);
	});
	return promise;
}

export async function waitForBackground(): Promise<void> {
	while (pending.size > 0) {
		await Promise.allSettled(Array.from(pending));
	}
}
