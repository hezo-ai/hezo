import { TERMINAL_TASK_STATUSES } from '@hezo/shared';
import { describe, expect, it, vi } from 'vitest';
import {
	buildUpdateSet,
	isFkViolation,
	isUniqueViolation,
	terminalStatusParams,
	withTransaction,
} from '../src/lib/sql';

// withTransaction only depends on db.query for BEGIN/COMMIT/ROLLBACK, so a tiny
// fake suffices to exercise both the commit and rollback branches without a DB.
function fakeDb() {
	const calls: string[] = [];
	const db = {
		query: vi.fn(async (sql: string) => {
			calls.push(sql);
			return { rows: [] };
		}),
	};
	return { db: db as unknown as Parameters<typeof withTransaction>[0], calls };
}

describe('withTransaction', () => {
	it('wraps the callback in BEGIN/COMMIT and returns its result', async () => {
		const { db, calls } = fakeDb();
		const result = await withTransaction(db, async () => 42);
		expect(result).toBe(42);
		expect(calls).toEqual(['BEGIN', 'COMMIT']);
	});

	it('issues ROLLBACK and rethrows when the callback throws', async () => {
		const { db, calls } = fakeDb();
		await expect(
			withTransaction(db, async () => {
				throw new Error('boom');
			}),
		).rejects.toThrow('boom');
		expect(calls).toEqual(['BEGIN', 'ROLLBACK']);
	});
});

describe('terminalStatusParams', () => {
	it('builds placeholders with a cast starting at the given index', () => {
		const { placeholders, values } = terminalStatusParams(1);
		const expected = TERMINAL_TASK_STATUSES.map((_, i) => `$${i + 1}::task_status`).join(', ');
		expect(placeholders).toBe(expected);
		expect(values).toEqual([...TERMINAL_TASK_STATUSES]);
	});

	it('omits the cast when withCast is false and respects the start index', () => {
		const { placeholders } = terminalStatusParams(3, false);
		expect(placeholders).toBe(TERMINAL_TASK_STATUSES.map((_, i) => `$${i + 3}`).join(', '));
	});
});

describe('buildUpdateSet', () => {
	it('skips undefined fields and numbers placeholders sequentially', () => {
		const { clauses, params, nextIdx } = buildUpdateSet([
			{ column: 'title', value: 'Hi' },
			{ column: 'skipped', value: undefined },
			{ column: 'count', value: 3 },
		]);
		expect(clauses).toEqual(['title = $1', 'count = $2']);
		expect(params).toEqual(['Hi', 3]);
		expect(nextIdx).toBe(3);
	});

	it('applies a cast and serializes jsonb values', () => {
		const { clauses, params } = buildUpdateSet([
			{ column: 'status', value: 'open', cast: 'task_status' },
			{ column: 'labels', value: ['a', 'b'], cast: 'jsonb' },
		]);
		expect(clauses).toEqual(['status = $1::task_status', 'labels = $2::jsonb']);
		expect(params).toEqual(['open', JSON.stringify(['a', 'b'])]);
	});

	it('honors a custom start index', () => {
		const { clauses, nextIdx } = buildUpdateSet([{ column: 'x', value: 1 }], 5);
		expect(clauses).toEqual(['x = $5']);
		expect(nextIdx).toBe(6);
	});

	it('returns empty clauses when all fields are undefined', () => {
		expect(buildUpdateSet([{ column: 'x', value: undefined }])).toEqual({
			clauses: [],
			params: [],
			nextIdx: 1,
		});
	});
});

describe('isFkViolation', () => {
	it('matches the FK error code', () => {
		expect(isFkViolation({ code: '23503' })).toBe(true);
	});

	it('optionally matches a specific constraint name', () => {
		expect(isFkViolation({ code: '23503', constraint: 'fk_a' }, 'fk_a')).toBe(true);
		expect(isFkViolation({ code: '23503', constraint: 'fk_a' }, 'fk_b')).toBe(false);
	});

	it('rejects non-objects and other codes', () => {
		expect(isFkViolation(null)).toBe(false);
		expect(isFkViolation('err')).toBe(false);
		expect(isFkViolation({ code: '23505' })).toBe(false);
	});
});

describe('isUniqueViolation', () => {
	it('matches the unique error code and optional constraint', () => {
		expect(isUniqueViolation({ code: '23505' })).toBe(true);
		expect(isUniqueViolation({ code: '23505', constraint: 'uq' }, 'uq')).toBe(true);
		expect(isUniqueViolation({ code: '23505', constraint: 'uq' }, 'other')).toBe(false);
	});

	it('rejects non-objects and other codes', () => {
		expect(isUniqueViolation(undefined)).toBe(false);
		expect(isUniqueViolation({ code: '23503' })).toBe(false);
	});
});
