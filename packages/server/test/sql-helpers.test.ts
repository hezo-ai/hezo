import { TERMINAL_TASK_STATUSES } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import {
	buildUpdateSet,
	isFkViolation,
	isUniqueViolation,
	stripNulBytes,
	terminalStatusParams,
	withTransaction,
} from '../src/lib/sql';
import { createTestDb } from './helpers/db';

const NUL = String.fromCharCode(0);

// withTransaction delegates to Db.transaction, whose routing (ALS pinning,
// nested join, rollback) is pinned by database-conformance.test.ts. Here we
// only prove the wrapper's contract on a real driver: commit-on-success with
// the callback's closed-over `db` writes included, rollback-and-rethrow on
// throw.
describe('withTransaction', () => {
	it('commits the callback writes and returns its result', async () => {
		const db = await createTestDb();
		try {
			await db.exec('CREATE TABLE tx_probe (id INT)');
			const result = await withTransaction(db, async () => {
				await db.query('INSERT INTO tx_probe (id) VALUES (1)');
				return 42;
			});
			expect(result).toBe(42);
			const rows = await db.query<{ id: number }>('SELECT id FROM tx_probe');
			expect(rows.rows).toEqual([{ id: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('rolls back and rethrows when the callback throws', async () => {
		const db = await createTestDb();
		try {
			await db.exec('CREATE TABLE tx_probe (id INT)');
			await expect(
				withTransaction(db, async () => {
					await db.query('INSERT INTO tx_probe (id) VALUES (1)');
					throw new Error('boom');
				}),
			).rejects.toThrow('boom');
			const rows = await db.query('SELECT id FROM tx_probe');
			expect(rows.rows).toEqual([]);
		} finally {
			await db.close();
		}
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

describe('stripNulBytes', () => {
	it('removes embedded NUL bytes that Postgres text/jsonb columns reject', () => {
		expect(stripNulBytes(`a${NUL}b${NUL}c`)).toBe('abc');
		expect(stripNulBytes(`${NUL}lead and trail${NUL}`)).toBe('lead and trail');
	});

	it('preserves surrounding text and other control characters', () => {
		expect(stripNulBytes(`line1\n\tline2${NUL} end`)).toBe('line1\n\tline2 end');
	});

	it('returns the input unchanged when there is no NUL', () => {
		const clean = 'plain log output\nwith newlines';
		expect(stripNulBytes(clean)).toBe(clean);
		expect(stripNulBytes('')).toBe('');
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
