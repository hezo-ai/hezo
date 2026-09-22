import { type DailyUsagePoint, useDailyUsageSeries } from '../../hooks/use-usage';
import { useI18n } from '../../lib/i18n';
import { formatDay } from '../charts/chart-format';
import { type SeriesCell, StackedSeriesChart } from '../charts/stacked-series-chart';

/** The two kinds of token a day bucket holds, stacked in this order. */
const INPUT = 'input';
const OUTPUT = 'output';

/** Split each day into input (cached input included) and output tokens. */
function toCells(
	points: DailyUsagePoint[] | undefined,
	labels: { input: string; output: string },
): SeriesCell[] {
	const cells: SeriesCell[] = [];
	for (const p of points ?? []) {
		cells.push({
			bucket: p.day,
			seriesKey: INPUT,
			seriesLabel: labels.input,
			value: p.input_tokens,
		});
		cells.push({
			bucket: p.day,
			seriesKey: OUTPUT,
			seriesLabel: labels.output,
			value: p.output_tokens,
		});
	}
	return cells;
}

/**
 * Per-day project token usage, input and output stacked. Responsive: full-width
 * and stacked on mobile, the bar/line toggle wraps above the chart.
 */
export function BudgetCharts({ projectId, title }: { projectId: string; title?: string }) {
	const { t, formatCompact } = useI18n();
	const { data, isLoading } = useDailyUsageSeries(projectId);

	return (
		<StackedSeriesChart
			title={title}
			cells={toCells(data?.summary, {
				input: t('budget.usage.series.input'),
				output: t('budget.usage.series.output'),
			})}
			isLoading={isLoading}
			toDisplay={(tokens) => tokens}
			formatValue={formatCompact}
			formatBucket={formatDay}
			// Fixed rather than sorted by total, so input keeps its colour on every day.
			seriesOrder={[INPUT, OUTPUT]}
			emptyText={t('budget.usage.chart.empty')}
			testId="budget-chart"
		/>
	);
}
