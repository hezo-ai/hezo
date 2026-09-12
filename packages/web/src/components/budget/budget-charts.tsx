import { type DailyCostPoint, useDailyCostSeries } from '../../hooks/use-costs';
import { useI18n } from '../../lib/i18n';
import { centsToPlottedDollars, formatDay, plottedDollars } from '../charts/chart-format';
import { type SeriesCell, StackedSeriesChart } from '../charts/stacked-series-chart';

/** The two kinds of money a day bucket can hold, stacked in this order. */
const BILLED = 'billed';
const NOTIONAL = 'notional';

/**
 * Split each day into what was charged and what was not.
 *
 * The unbilled segment is emitted only on days that have one, so a project
 * paying for every run keeps the single-series chart it has always had - and one
 * running entirely on subscriptions gets a chart instead of an empty panel
 * claiming no spend.
 */
function toCells(
	points: DailyCostPoint[] | undefined,
	labels: { billed: string; notBilled: string },
): SeriesCell[] {
	const cells: SeriesCell[] = [];
	for (const p of points ?? []) {
		cells.push({
			bucket: p.day,
			seriesKey: BILLED,
			seriesLabel: labels.billed,
			value: p.total_cents,
		});
		if (p.notional_cents > 0) {
			cells.push({
				bucket: p.day,
				seriesKey: NOTIONAL,
				seriesLabel: labels.notBilled,
				value: p.notional_cents,
			});
		}
	}
	return cells;
}

/**
 * Per-day project spend, billed and unbilled stacked. Responsive: full-width and
 * stacked on mobile, the bar/line toggle wraps above the chart.
 */
export function BudgetCharts({ projectId, title }: { projectId: string; title?: string }) {
	const { t } = useI18n();
	const { data, isLoading } = useDailyCostSeries(projectId);

	return (
		<StackedSeriesChart
			title={title}
			cells={toCells(data?.summary, {
				billed: t('cost.series.billed'),
				notBilled: t('cost.series.notBilled'),
			})}
			isLoading={isLoading}
			toDisplay={centsToPlottedDollars}
			formatValue={plottedDollars}
			formatBucket={formatDay}
			// Fixed rather than sorted by total, so the billed segment is the same
			// colour whether or not a project is mostly running on subscriptions.
			seriesOrder={[BILLED, NOTIONAL]}
			emptyText="No spend recorded."
			testId="budget-chart"
		/>
	);
}
