import { describe, expect, test } from 'vitest';
import { dollars, formatDay } from '../src/components/budget/chart-format';

describe('formatDay', () => {
	test('formats a date-only YYYY-MM-DD string as a short label', () => {
		expect(formatDay('2024-01-15')).toBe('Jan 15');
	});

	test('formats in UTC regardless of local time zone (no off-by-one)', () => {
		// Midnight-UTC parsing + UTC formatting keeps the calendar day stable.
		expect(formatDay('2024-12-31')).toBe('Dec 31');
		expect(formatDay('2024-03-01')).toBe('Mar 1');
	});

	test('tolerates a full ISO timestamp by slicing to the date part', () => {
		// Regression: a Postgres `date` once serialized as "...T00:00:00.000Z". The old
		// formatter built `${day}T00:00:00Z` from that and produced "Invalid Date".
		expect(formatDay('2024-01-15T00:00:00.000Z')).toBe('Jan 15');
	});

	test('never returns the literal "Invalid Date" for empty or junk input', () => {
		expect(formatDay('')).toBe('');
		expect(formatDay('not-a-date')).toBe('not-a-date');
	});
});

describe('dollars', () => {
	test('renders cents as a 2-decimal dollar string', () => {
		expect(dollars(898)).toBe('$8.98');
		expect(dollars(0)).toBe('$0.00');
		expect(dollars(100000)).toBe('$1000.00');
	});
});
