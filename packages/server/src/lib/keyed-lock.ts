/**
 * Promise-chain keyed mutex: serializes async work per key while different keys
 * proceed independently. In-process only (single-server assumption). Callers own
 * their Map so each lock family (git ops, container lifecycle, ...) has its own
 * key space and its own documented scope.
 */
export function withKeyedLock<T>(
	locks: Map<string, Promise<unknown>>,
	key: string,
	fn: () => Promise<T>,
): Promise<T> {
	const prev = locks.get(key) ?? Promise.resolve();
	const run = prev.then(() => fn());
	const tail = run.catch(() => {});
	locks.set(key, tail);
	void tail.then(() => {
		if (locks.get(key) === tail) locks.delete(key);
	});
	return run;
}
