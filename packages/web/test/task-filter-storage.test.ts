import { TaskStatus } from '@hezo/shared';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
	clearStoredTaskFilters,
	readStoredTaskFilters,
	type StoredTaskFilters,
	writeStoredTaskFilters,
} from '../src/lib/task-filter-storage';

const KEY = 'hezo:task-filters:ops';

function fullFilters(): StoredTaskFilters {
	return {
		search: 'bug',
		statusValues: [TaskStatus.InProgress, TaskStatus.Done],
		ownerValues: ['agent-1'],
		sortField: 'created_at',
		sortDir: 'desc',
	};
}

describe('task-filter-storage', () => {
	beforeEach(() => {
		localStorage.clear();
	});
	afterEach(() => {
		vi.restoreAllMocks();
		localStorage.clear();
	});

	test('write then read round-trips all fields', () => {
		writeStoredTaskFilters('ops', fullFilters());
		expect(readStoredTaskFilters('ops')).toEqual(fullFilters());
	});

	test('write keys storage by project slug', () => {
		writeStoredTaskFilters('ops', fullFilters());
		expect(localStorage.getItem(KEY)).not.toBeNull();
		expect(readStoredTaskFilters('other')).toBeNull();
	});

	test('read returns null when nothing is stored', () => {
		expect(readStoredTaskFilters('ops')).toBeNull();
	});

	test('read returns null for an empty projectId', () => {
		expect(readStoredTaskFilters('')).toBeNull();
	});

	test('write is a no-op for an empty projectId', () => {
		writeStoredTaskFilters('', fullFilters());
		expect(localStorage.length).toBe(0);
	});

	test('read returns null on malformed JSON', () => {
		localStorage.setItem(KEY, '{not json');
		expect(readStoredTaskFilters('ops')).toBeNull();
	});

	test('read returns null when stored value is a JSON primitive, not an object', () => {
		localStorage.setItem(KEY, '"a string"');
		expect(readStoredTaskFilters('ops')).toBeNull();
	});

	test('read returns null when stored value is JSON null', () => {
		localStorage.setItem(KEY, 'null');
		expect(readStoredTaskFilters('ops')).toBeNull();
	});

	test('read coerces missing/garbage fields to safe defaults', () => {
		localStorage.setItem(KEY, JSON.stringify({}));
		expect(readStoredTaskFilters('ops')).toEqual({
			search: '',
			statusValues: [],
			ownerValues: [],
			sortField: 'work_order',
			sortDir: 'asc',
		});
	});

	test('read coerces a non-string search to empty string', () => {
		localStorage.setItem(KEY, JSON.stringify({ search: 123 }));
		expect(readStoredTaskFilters('ops')?.search).toBe('');
	});

	test('read drops unknown/stale status values', () => {
		localStorage.setItem(
			KEY,
			JSON.stringify({ statusValues: [TaskStatus.Done, 'closed', 'bogus'] }),
		);
		expect(readStoredTaskFilters('ops')?.statusValues).toEqual([TaskStatus.Done]);
	});

	test('read filters non-string entries out of statusValues and ownerValues', () => {
		localStorage.setItem(
			KEY,
			JSON.stringify({ statusValues: [TaskStatus.Done, 5, null], ownerValues: ['a', 7, {}] }),
		);
		const r = readStoredTaskFilters('ops');
		expect(r?.statusValues).toEqual([TaskStatus.Done]);
		expect(r?.ownerValues).toEqual(['a']);
	});

	test('read defaults non-array statusValues/ownerValues to empty arrays', () => {
		localStorage.setItem(KEY, JSON.stringify({ statusValues: 'nope', ownerValues: 42 }));
		const r = readStoredTaskFilters('ops');
		expect(r?.statusValues).toEqual([]);
		expect(r?.ownerValues).toEqual([]);
	});

	test('read rejects an unknown sortField and falls back to work_order', () => {
		localStorage.setItem(KEY, JSON.stringify({ sortField: 'priority' }));
		expect(readStoredTaskFilters('ops')?.sortField).toBe('work_order');
	});

	test('read rejects an unknown sortDir and falls back to asc', () => {
		localStorage.setItem(KEY, JSON.stringify({ sortDir: 'sideways' }));
		expect(readStoredTaskFilters('ops')?.sortDir).toBe('asc');
	});

	test('read accepts each valid sortField/sortDir', () => {
		localStorage.setItem(KEY, JSON.stringify({ sortField: 'updated_at', sortDir: 'desc' }));
		const r = readStoredTaskFilters('ops');
		expect(r?.sortField).toBe('updated_at');
		expect(r?.sortDir).toBe('desc');
	});

	test('clear removes a stored entry', () => {
		writeStoredTaskFilters('ops', fullFilters());
		clearStoredTaskFilters('ops');
		expect(readStoredTaskFilters('ops')).toBeNull();
	});

	test('clear is a no-op for an empty projectId', () => {
		writeStoredTaskFilters('ops', fullFilters());
		clearStoredTaskFilters('');
		expect(readStoredTaskFilters('ops')).not.toBeNull();
	});

	test('read swallows a throwing getItem and returns null', () => {
		vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
			throw new Error('private mode');
		});
		expect(readStoredTaskFilters('ops')).toBeNull();
	});

	test('write swallows a throwing setItem', () => {
		vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
			throw new Error('quota');
		});
		expect(() => writeStoredTaskFilters('ops', fullFilters())).not.toThrow();
	});

	test('clear swallows a throwing removeItem', () => {
		vi.spyOn(localStorage, 'removeItem').mockImplementation(() => {
			throw new Error('unavailable');
		});
		expect(() => clearStoredTaskFilters('ops')).not.toThrow();
	});
});
