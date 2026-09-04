export interface ProgressProps {
	/** Position in the caller's units. Values outside `[min, max]` are clamped. */
	value: number;
	/** Where the bar starts. Defaults to 0. */
	min?: number;
	/** Where the bar is full. Defaults to 100, so the default bar counts percent. */
	max?: number;
	className?: string;
	/** Tailwind class(es) for the filled bar. Defaults to the info tone. */
	barClassName?: string;
	/** Accessible label for the bar. */
	label?: string;
	testId?: string;
}

/**
 * A slim determinate progress bar. Mobile-first: full-width, fixed height,
 * animates its fill width. Exposes the standard `progressbar` ARIA role so the
 * value is readable by assistive tech and assertable in tests.
 *
 * `min` and `max` let the ARIA say what is being counted: a bar over "step 5
 * of 6" reports 5 of 6, not 83 of 100.
 */
export function Progress({
	value,
	min = 0,
	max = 100,
	className = '',
	barClassName = 'bg-info',
	label,
	testId,
}: ProgressProps) {
	// An empty range ("step 0 of 0") comes from live data, so it draws an empty
	// bar rather than throwing at a page.
	const span = max - min;
	const clamped = span > 0 ? Math.max(min, Math.min(max, Math.round(value))) : min;
	// Rounded: `7 / 100 * 100` is not a whole number in floating point.
	const percent = span > 0 ? Math.round(((clamped - min) / span) * 100) : 0;
	return (
		<div
			role="progressbar"
			aria-valuenow={clamped}
			aria-valuemin={min}
			aria-valuemax={Math.max(min, max)}
			aria-label={label}
			data-testid={testId}
			className={`h-1.5 w-full overflow-hidden rounded-full bg-neutral-soft ${className}`}
		>
			<div
				className={`h-full rounded-full transition-[width] duration-300 ease-out ${barClassName}`}
				style={{ width: `${percent}%` }}
			/>
		</div>
	);
}
