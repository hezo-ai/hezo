import {
	DateFormat,
	DEFAULT_LOCALE_SETTINGS,
	formatDateIn,
	Language,
	NumberFormat,
} from '@hezo/shared';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
	formatDate,
	formatDateTime,
	formatRelativeTime,
	formatRelativeTimeCompact,
	setActiveLocale,
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

/** The absolute date these helpers fall back to, in the active locale. */
function absolute(iso: string): string {
	return formatDateIn(new Date(iso), DEFAULT_LOCALE_SETTINGS);
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	// These helpers render through the instance locale, whose only writer in
	// production is I18nProvider. Pin it so the suite is deterministic.
	setActiveLocale(DEFAULT_LOCALE_SETTINGS);
});

afterEach(() => {
	vi.useRealTimers();
	setActiveLocale(DEFAULT_LOCALE_SETTINGS);
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
		expect(formatRelativeTime(iso)).toBe(absolute(iso));
		// Exactly 7 days is the boundary — the date, not "7 days ago".
		const boundary = ago(7 * DAY);
		expect(formatRelativeTime(boundary)).toBe(absolute(boundary));
	});

	test('stays relative past the cutoff when asked', () => {
		expect(formatRelativeTime(ago(9 * DAY), { alwaysRelative: true })).toBe('9 days ago');
		expect(formatRelativeTime(ago(400 * DAY), { alwaysRelative: true })).toBe('1 year ago');
		const future = new Date(NOW.getTime() + 30 * DAY).toISOString();
		expect(formatRelativeTime(future, { alwaysRelative: true })).toBe('in 1 month');
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
		expect(formatRelativeTimeCompact(iso)).toBe(absolute(iso));
	});

	test('counts on past the cutoff in days when asked', () => {
		expect(formatRelativeTimeCompact(ago(9 * DAY), { alwaysRelative: true })).toBe('9d');
	});

	test('returns "" for empty or unparsable input', () => {
		expect(formatRelativeTimeCompact('')).toBe('');
		expect(formatRelativeTimeCompact('nope')).toBe('');
	});
});

describe('formatDateTime / formatDate', () => {
	test('formatDateTime returns the date plus a time, "" when unparsable', () => {
		const iso = ago(DAY);
		expect(formatDateTime(iso).startsWith(absolute(iso))).toBe(true);
		expect(formatDateTime(iso)).toMatch(/\d/);
		expect(formatDateTime('')).toBe('');
		expect(formatDateTime('bad')).toBe('');
	});

	test('formatDate returns the date only, "" when unparsable', () => {
		const iso = ago(DAY);
		expect(formatDate(iso)).toBe(absolute(iso));
		expect(formatDate(null)).toBe('');
	});
});

describe('the active instance locale drives these helpers', () => {
	test('the chosen date format changes field order everywhere', () => {
		const iso = ago(8 * DAY);

		setActiveLocale({ ...DEFAULT_LOCALE_SETTINGS, date_format: DateFormat.Mdy });
		expect(formatDate(iso)).toBe('07/11/2026');

		setActiveLocale({ ...DEFAULT_LOCALE_SETTINGS, date_format: DateFormat.Dmy });
		expect(formatDate(iso)).toBe('11/07/2026');

		setActiveLocale({ ...DEFAULT_LOCALE_SETTINGS, date_format: DateFormat.Ymd });
		expect(formatDate(iso)).toBe('2026-07-11');
		// The >7-day fallback path reads the same locale, not a separate one.
		expect(formatRelativeTime(iso)).toBe('2026-07-11');
		expect(formatRelativeTimeCompact(iso)).toBe('2026-07-11');
	});

	test('relative phrases are spoken in the chosen language', () => {
		setActiveLocale({
			language: Language.De,
			date_format: DateFormat.Dmy,
			number_format: NumberFormat.CommaDot,
		});
		// date-fns carries its own per-language locale objects; this proves the
		// mapping is wired, not just the numeric formats.
		expect(formatRelativeTime(ago(2 * DAY))).toBe('vor 2 Tagen');
	});
});
