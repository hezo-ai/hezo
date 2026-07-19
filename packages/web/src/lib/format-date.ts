import {
	differenceInDays,
	differenceInHours,
	differenceInMinutes,
	differenceInSeconds,
	formatDistanceToNowStrict,
} from 'date-fns';

/**
 * Shared date/time formatting for the web app. Timestamps are rendered as a
 * relative "X ago" phrase for the recent past (up to a week) and fall back to an
 * absolute date once they're older, while the full local date+time is always
 * available for a tooltip via {@link formatDateTime}.
 *
 * These are pure functions (no React) so they can be unit-tested directly; the
 * `<RelativeTime>` component pairs a relative label with the absolute-date
 * tooltip.
 */

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Parse an ISO string to a Date, or `null` when empty/unparsable. */
function parseDate(iso: string | null | undefined): Date | null {
	if (!iso) return null;
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? null : d;
}

/** Full local date + time — used for every timestamp tooltip. `''` when unparsable. */
export function formatDateTime(iso: string | null | undefined): string {
	const d = parseDate(iso);
	return d ? d.toLocaleString() : '';
}

/** Local date only (no time) — the fallback label once a timestamp is older than a week. `''` when unparsable. */
export function formatDate(iso: string | null | undefined): string {
	const d = parseDate(iso);
	return d ? d.toLocaleDateString() : '';
}

/**
 * Relative label: `"30 seconds ago"`, `"1 hour ago"`, `"2 days ago"`, up to a
 * week; anything older (or more than a week in the future) falls back to the
 * absolute date. Near-future timestamps read as `"in 5 minutes"`. `''` when
 * unparsable.
 */
export function formatRelativeTime(iso: string | null | undefined): string {
	const d = parseDate(iso);
	if (!d) return '';
	if (Math.abs(Date.now() - d.getTime()) >= SEVEN_DAYS_MS) return d.toLocaleDateString();
	return formatDistanceToNowStrict(d, { addSuffix: true });
}

/**
 * Compact relative label for space-constrained spots: `"now"`, `"5m"`, `"3h"`,
 * `"2d"`; older than a week falls back to the absolute date. `''` when
 * unparsable.
 */
export function formatRelativeTimeCompact(iso: string | null | undefined): string {
	const d = parseDate(iso);
	if (!d) return '';
	const now = Date.now();
	if (Math.abs(now - d.getTime()) >= SEVEN_DAYS_MS) return d.toLocaleDateString();
	if (differenceInSeconds(now, d) < 60) return 'now';
	const minutes = differenceInMinutes(now, d);
	if (minutes < 60) return `${minutes}m`;
	const hours = differenceInHours(now, d);
	if (hours < 24) return `${hours}h`;
	return `${differenceInDays(now, d)}d`;
}
