/**
 * Formatting shared by the budget charts (project total + stacked breakdowns).
 * Kept in one place so the x-axis label and tooltip render identically and the
 * "Invalid Date" guard lives in a single, unit-tested function.
 */

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
	const datePart = (day ?? '').slice(0, 10);
	const d = new Date(`${datePart}T00:00:00Z`);
	if (Number.isNaN(d.getTime())) return day ?? '';
	return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function dollars(cents: number): string {
	return `$${(cents / 100).toFixed(2)}`;
}
