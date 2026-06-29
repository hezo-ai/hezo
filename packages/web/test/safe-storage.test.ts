import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readStored, removeStored, writeStored } from '../src/lib/safe-storage';

describe('safe-storage', () => {
	beforeEach(() => {
		localStorage.clear();
	});
	afterEach(() => {
		vi.restoreAllMocks();
		localStorage.clear();
	});

	test('writeStored then readStored round-trips a value', () => {
		writeStored('k', 'v');
		expect(readStored('k')).toBe('v');
		expect(localStorage.getItem('k')).toBe('v');
	});

	test('readStored returns null for a missing key', () => {
		expect(readStored('absent')).toBeNull();
	});

	test('removeStored deletes a stored value', () => {
		writeStored('k', 'v');
		removeStored('k');
		expect(readStored('k')).toBeNull();
		expect(localStorage.getItem('k')).toBeNull();
	});

	test('writeStored overwrites an existing value', () => {
		writeStored('k', 'one');
		writeStored('k', 'two');
		expect(readStored('k')).toBe('two');
	});

	test('readStored swallows a throwing getItem and returns null', () => {
		vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
			throw new Error('private mode');
		});
		expect(readStored('k')).toBeNull();
	});

	test('writeStored swallows a throwing setItem (quota exceeded)', () => {
		vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
			throw new Error('quota exceeded');
		});
		expect(() => writeStored('k', 'v')).not.toThrow();
	});

	test('removeStored swallows a throwing removeItem', () => {
		vi.spyOn(localStorage, 'removeItem').mockImplementation(() => {
			throw new Error('unavailable');
		});
		expect(() => removeStored('k')).not.toThrow();
	});
});
