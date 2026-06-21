interface ProgressProps {
	/** Completion 0–100. Values outside the range are clamped. */
	value: number;
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
 */
export function Progress({
	value,
	className = '',
	barClassName = 'bg-info',
	label,
	testId,
}: ProgressProps) {
	const clamped = Math.max(0, Math.min(100, Math.round(value)));
	return (
		<div
			role="progressbar"
			aria-valuenow={clamped}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-label={label}
			data-testid={testId}
			className={`h-1.5 w-full overflow-hidden rounded-full bg-neutral-soft ${className}`}
		>
			<div
				className={`h-full rounded-full transition-[width] duration-300 ease-out ${barClassName}`}
				style={{ width: `${clamped}%` }}
			/>
		</div>
	);
}
