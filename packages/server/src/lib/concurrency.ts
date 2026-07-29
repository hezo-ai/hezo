/**
 * Bounded fan-out.
 *
 * `Promise.all(rows.map(fn))` is the reflex, and it is almost always wrong here:
 * the array is row-count-sized, so a large result set starts an unbounded number
 * of tasks at once, and every one of them ends up queued behind the same
 * serialized database anyway (PGlite is a single connection; the Postgres driver
 * funnels transaction blocks through one queue). Unbounded fan-out therefore
 * buys no parallelism at all — it just deepens the queue, spikes memory, and can
 * bury the Docker socket or an upstream API under a burst.
 */

/**
 * Run `fn` over `items` with at most `limit` in flight, returning results in
 * input order. A rejection propagates; other in-flight tasks settle but no new
 * ones start.
 */
export async function mapConcurrent<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workerCount = Math.max(1, Math.min(limit, items.length));
	const workers: Promise<void>[] = [];
	for (let i = 0; i < workerCount; i++) {
		workers.push(
			(async () => {
				for (;;) {
					const index = next++;
					if (index >= items.length) return;
					results[index] = await fn(items[index], index);
				}
			})(),
		);
	}
	await Promise.all(workers);
	return results;
}

/** `mapConcurrent` for side effects only. */
export async function forEachConcurrent<T>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
	await mapConcurrent(items, limit, fn);
}
