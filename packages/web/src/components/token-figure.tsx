import { useI18n } from '../lib/i18n';
import { Tooltip } from './ui/tooltip';

/**
 * A run's or task's tokens, shortened for a glance with the exact count on hover.
 * The count is what a budget counts: input, cached input included, plus output.
 */
export function TokenFigure({
	tokens,
	approximate = false,
	className,
	testId,
}: {
	tokens: number;
	/** Prefix a "~" - the usage behind the figure is a mid-run snapshot. */
	approximate?: boolean;
	className?: string;
	testId?: string;
}) {
	const { t, formatCompact, formatNumber } = useI18n();
	return (
		<Tooltip content={t('usage.figure.exact', { count: formatNumber(tokens) })}>
			<span className={className} data-testid={testId}>
				{approximate ? '~' : ''}
				{t('usage.figure.short', { count: formatCompact(tokens) })}
			</span>
		</Tooltip>
	);
}
