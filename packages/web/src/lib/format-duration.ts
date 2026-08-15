/**
 * Compact wall-clock duration ("35s", "7m 41s", "1h 4m", "54h 24m") from a
 * seconds total.
 *
 * Distinct from `formatElapsed` (`hooks/use-elapsed-duration`), which always
 * carries seconds because it ticks live beside a running task. This one drops
 * the smallest unit once a larger one is present, which is what a settled
 * figure in a table or a chart tooltip wants.
 */
export function formatDuration(totalSeconds: number): string {
	const total = Math.max(0, Math.round(totalSeconds));
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const mins = minutes % 60;
	return mins ? `${hours}h ${mins}m` : `${hours}h`;
}

/**
 * Seconds as a number of hours, for a chart's Y axis. Deliberately unrounded:
 * `hoursSpent` reads the plotted number back to format a tooltip, so rounding
 * here would round what the reader is shown.
 */
export function secondsToHours(totalSeconds: number): number {
	return Math.max(0, totalSeconds) / 3600;
}

/** The exact inverse of `secondsToHours`, formatted - a chart tooltip's other half. */
export function hoursSpent(hours: number): string {
	return formatDuration(Math.round(hours * 3600));
}
