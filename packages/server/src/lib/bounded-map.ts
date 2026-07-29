/**
 * A `Map` with a size ceiling, evicting least-recently-used entries.
 *
 * Exists because "just memoize it in a Map" is the easy half of caching and the
 * eviction rule is the half that gets forgotten. A module-level `Map` keyed by
 * anything user-supplied - a chat user id, a channel id, a thread key - grows
 * for the life of the process, which is a slow leak on any busy workspace.
 *
 * Reads and writes both refresh recency (a `Map` preserves insertion order, so
 * re-inserting moves the key to the end and the oldest key is simply the first).
 */
export class BoundedMap<K, V> {
	private readonly entries = new Map<K, V>();

	constructor(private readonly maxSize: number) {
		if (maxSize < 1) throw new Error('BoundedMap requires maxSize >= 1');
	}

	get(key: K): V | undefined {
		const value = this.entries.get(key);
		if (value === undefined) return undefined;
		// Refresh recency.
		this.entries.delete(key);
		this.entries.set(key, value);
		return value;
	}

	has(key: K): boolean {
		return this.entries.has(key);
	}

	set(key: K, value: V): void {
		if (this.entries.has(key)) this.entries.delete(key);
		this.entries.set(key, value);
		while (this.entries.size > this.maxSize) {
			const oldest = this.entries.keys().next();
			if (oldest.done) break;
			this.entries.delete(oldest.value);
		}
	}

	delete(key: K): boolean {
		return this.entries.delete(key);
	}

	clear(): void {
		this.entries.clear();
	}

	get size(): number {
		return this.entries.size;
	}
}
