import { useI18n } from '../lib/i18n';
import { Tooltip } from './ui/tooltip';

/**
 * The two ways a cost reaches a screen, so an imputed figure can never render
 * as money someone was charged.
 *
 * A run on a subscription is not billed per token, yet it consumes the same
 * tokens and is priced from the same table. Both components carry the same
 * explanation on hover; the difference is only whether the figure sits where a
 * charge would sit, or beside one.
 */

/** A run or task cost, tagged when nobody was billed for it. */
export function CostFigure({
	cents,
	billed,
	approximate = false,
	className,
	testId,
}: {
	cents: number;
	billed: boolean;
	/** Prefix a "~" - the usage behind the figure is a mid-run snapshot. */
	approximate?: boolean;
	className?: string;
	testId?: string;
}) {
	const { t, formatMoney } = useI18n();
	const amount = `${approximate ? '~' : ''}${formatMoney(cents)}`;
	if (billed) {
		return (
			<span className={className} data-testid={testId}>
				{amount}
			</span>
		);
	}
	return (
		<Tooltip content={t('cost.notional.explainer')}>
			<span className={className} data-testid={testId}>
				{amount} <span className="text-text-3">{t('cost.notional.tag')}</span>
			</span>
		</Tooltip>
	);
}

/** An unbilled total shown alongside real spend, never inside it. */
export function NotionalFigure({
	cents,
	className,
	testId,
}: {
	cents: number;
	className?: string;
	testId?: string;
}) {
	const { t, formatMoney } = useI18n();
	return (
		<Tooltip content={t('cost.notional.explainer')}>
			<span className={className} data-testid={testId}>
				{t('cost.notional.withAmount', { amount: formatMoney(cents) })}
			</span>
		</Tooltip>
	);
}
