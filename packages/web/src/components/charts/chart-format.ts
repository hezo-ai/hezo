import { centsToDollars, type HoursBucket } from '@hezo/shared';

/**
 * Formatting shared by every per-bucket chart (budget spend, activity hours).
 * Kept in one place so the x-axis label and tooltip render identically and the
 * "Invalid Date" guard lives in a single, unit-tested function.
 */

/** The date-only part of a bucket key, parsed as UTC. Null when unparseable. */
function parseBucket(bucket: string): Date | null {
	const datePart = (bucket ?? '').slice(0, 10);
	const d = new Date(`${datePart}T00:00:00Z`);
	return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Render a per-day bucket as a short "Mon DD" label.
 *
 * `day` is meant to be a date-only string (YYYY-MM-DD) from the costs API. We're
 * defensive on two fronts so a label is never the literal string "Invalid Date":
 *  - slice to the first 10 chars, so a full ISO timestamp ("2024-01-15T00:00:00.000Z",
 *    the shape a Postgres `date` takes once JSON-serialized) still parses; and
 *  - fall back to the raw input if the result isn't a real date.
 */
export function formatDay(day: string): string {
	const d = parseBucket(day);
	if (!d) return day ?? '';
	return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * Render a bucket key at the granularity it was aggregated to. Day and week
 * both key off the bucket's first date, so they read the same; month drops the
 * day and carries the year, since a twelve-month window spans two of them.
 */
export function formatBucketLabel(bucket: string, size: HoursBucket): string {
	if (size !== 'month') return formatDay(bucket);
	const d = parseBucket(bucket);
	if (!d) return bucket ?? '';
	return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
}

/** The one place cents become a displayed dollar amount on a chart or a budget row. */
export function dollars(cents: number): string {
	return `$${centsToDollars(cents)}`;
}
