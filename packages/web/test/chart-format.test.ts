import { describe, expect, test } from 'vitest';
import { dollars, formatBucketLabel, formatDay } from '../src/components/charts/chart-format';
import { hoursSpent, secondsToHours } from '../src/lib/format-duration';

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

describe('formatBucketLabel', () => {
	test('day and week buckets both read as the first date in the bucket', () => {
		expect(formatBucketLabel('2024-01-15', 'day')).toBe('Jan 15');
		expect(formatBucketLabel('2024-01-15', 'week')).toBe('Jan 15');
	});

	// A twelve-month window spans two calendar years, so the month label has to
	// carry one - "Jan" alone would collide with the January before it.
	test('a month bucket drops the day and carries the year', () => {
		expect(formatBucketLabel('2024-08-01', 'month')).toBe('Aug 24');
		expect(formatBucketLabel('2025-01-01', 'month')).toBe('Jan 25');
	});

	test('never returns the literal "Invalid Date" for junk input', () => {
		expect(formatBucketLabel('', 'month')).toBe('');
		expect(formatBucketLabel('not-a-date', 'month')).toBe('not-a-date');
	});
});

// The chart plots a converted number and formats that same number back for its
// tooltip, so the pair has to round-trip exactly - a rounded plot value would be
// a rounded tooltip, and 5h 24m would read as 5h 23m.
describe('plotted-value round trips', () => {
	test('seconds survive the hours conversion the chart plots', () => {
		for (const seconds of [0, 1, 59, 60, 2700, 3600, 3661, 194_400]) {
			expect(Math.round(secondsToHours(seconds) * 3600)).toBe(seconds);
		}
		expect(hoursSpent(secondsToHours(2700))).toBe('45m');
		expect(hoursSpent(secondsToHours(194_400))).toBe('54h');
		expect(hoursSpent(secondsToHours(195_840))).toBe('54h 24m');
	});

	test('cents survive the dollars conversion the chart plots', () => {
		for (const cents of [0, 1, 99, 100, 898, 100_000]) {
			expect(Math.round((cents / 100) * 100)).toBe(cents);
		}
		expect(dollars(Math.round((898 / 100) * 100))).toBe('$8.98');
	});
});
