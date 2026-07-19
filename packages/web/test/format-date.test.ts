import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
	formatDate,
	formatDateTime,
	formatRelativeTime,
	formatRelativeTimeCompact,
} from '../src/lib/format-date';

// A fixed "now" so the relative math is deterministic regardless of when the
// suite runs. date-fns reads Date.now(), which vi.setSystemTime controls.
const NOW = new Date('2026-07-19T12:00:00.000Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** ISO string for a timestamp `ms` in the past relative to the frozen NOW. */
function ago(ms: number): string {
	return new Date(NOW.getTime() - ms).toISOString();
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
});

describe('formatRelativeTime', () => {
	test('phrases recent past exactly as requested', () => {
		expect(formatRelativeTime(ago(30 * SECOND))).toBe('30 seconds ago');
		expect(formatRelativeTime(ago(HOUR))).toBe('1 hour ago');
		expect(formatRelativeTime(ago(6 * HOUR))).toBe('6 hours ago');
		expect(formatRelativeTime(ago(DAY))).toBe('1 day ago');
		expect(formatRelativeTime(ago(2 * DAY))).toBe('2 days ago');
	});

	test('stays relative right up to the 7-day cutoff', () => {
		expect(formatRelativeTime(ago(6 * DAY))).toBe('6 days ago');
		// 6d23h rounds up to "7 days ago" but is still under the cutoff.
		expect(formatRelativeTime(ago(6 * DAY + 23 * HOUR))).toBe('7 days ago');
	});

	test('falls back to the absolute date once older than 7 days', () => {
		const iso = ago(8 * DAY);
		expect(formatRelativeTime(iso)).toBe(new Date(iso).toLocaleDateString());
		// Exactly 7 days is the boundary — the date, not "7 days ago".
		const boundary = ago(7 * DAY);
		expect(formatRelativeTime(boundary)).toBe(new Date(boundary).toLocaleDateString());
	});

	test('reads as "in …" for near-future timestamps', () => {
		const future = new Date(NOW.getTime() + HOUR).toISOString();
		expect(formatRelativeTime(future)).toBe('in 1 hour');
	});

	test('returns "" for empty or unparsable input', () => {
		expect(formatRelativeTime('')).toBe('');
		expect(formatRelativeTime(null)).toBe('');
		expect(formatRelativeTime(undefined)).toBe('');
		expect(formatRelativeTime('not-a-date')).toBe('');
	});
});

describe('formatRelativeTimeCompact', () => {
	test('uses terse unit-letter forms', () => {
		expect(formatRelativeTimeCompact(ago(30 * SECOND))).toBe('now');
		expect(formatRelativeTimeCompact(ago(5 * MINUTE))).toBe('5m');
		expect(formatRelativeTimeCompact(ago(3 * HOUR))).toBe('3h');
		expect(formatRelativeTimeCompact(ago(2 * DAY))).toBe('2d');
	});

	test('falls back to the absolute date once older than 7 days', () => {
		const iso = ago(8 * DAY);
		expect(formatRelativeTimeCompact(iso)).toBe(new Date(iso).toLocaleDateString());
	});

	test('returns "" for empty or unparsable input', () => {
		expect(formatRelativeTimeCompact('')).toBe('');
		expect(formatRelativeTimeCompact('nope')).toBe('');
	});
});

describe('formatDateTime / formatDate', () => {
	test('formatDateTime returns the full local date+time, "" when unparsable', () => {
		const iso = ago(DAY);
		expect(formatDateTime(iso)).toBe(new Date(iso).toLocaleString());
		expect(formatDateTime('')).toBe('');
		expect(formatDateTime('bad')).toBe('');
	});

	test('formatDate returns the local date only, "" when unparsable', () => {
		const iso = ago(DAY);
		expect(formatDate(iso)).toBe(new Date(iso).toLocaleDateString());
		expect(formatDate(null)).toBe('');
	});
});
