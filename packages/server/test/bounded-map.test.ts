import { describe, expect, it } from 'vitest';
import { BoundedMap } from '../src/lib/bounded-map';

describe('BoundedMap', () => {
	it('stores and reads back like a Map', () => {
		const m = new BoundedMap<string, number>(3);
		m.set('a', 1);
		expect(m.get('a')).toBe(1);
		expect(m.has('a')).toBe(true);
		expect(m.has('b')).toBe(false);
		expect(m.size).toBe(1);
	});

	// The whole point: a module-level Map keyed by user-supplied ids grows for
	// the life of the process.
	it('never grows past its ceiling, evicting the least recently used', () => {
		const m = new BoundedMap<string, number>(3);
		m.set('a', 1);
		m.set('b', 2);
		m.set('c', 3);
		m.set('d', 4);

		expect(m.size).toBe(3);
		expect(m.has('a')).toBe(false);
		expect([m.get('b'), m.get('c'), m.get('d')]).toEqual([2, 3, 4]);
	});

	it('a read refreshes recency, so a hot key survives eviction', () => {
		const m = new BoundedMap<string, number>(3);
		m.set('a', 1);
		m.set('b', 2);
		m.set('c', 3);
		expect(m.get('a')).toBe(1); // 'a' is now the most recent
		m.set('d', 4);

		expect(m.has('a')).toBe(true);
		expect(m.has('b')).toBe(false);
	});

	it('overwriting a key updates it without growing', () => {
		const m = new BoundedMap<string, number>(2);
		m.set('a', 1);
		m.set('a', 2);
		expect(m.size).toBe(1);
		expect(m.get('a')).toBe(2);
	});

	it('delete and clear behave like a Map', () => {
		const m = new BoundedMap<string, number>(2);
		m.set('a', 1);
		expect(m.delete('a')).toBe(true);
		expect(m.delete('a')).toBe(false);
		m.set('b', 2);
		m.clear();
		expect(m.size).toBe(0);
	});

	it('rejects a ceiling that could never hold anything', () => {
		expect(() => new BoundedMap<string, number>(0)).toThrow();
	});
});
