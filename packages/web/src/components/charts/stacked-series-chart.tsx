import { useState } from 'react';
import {
	Bar,
	BarChart,
	CartesianGrid,
	Legend,
	Line,
	LineChart,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from 'recharts';

type ChartKind = 'bar' | 'line';

/**
 * A single (bucket, series) cell. `seriesKey` is the stable id; `seriesLabel` is
 * shown. `value` stays in the API's own base unit (cents, seconds) so the pivot
 * sums integers exactly - conversion to the plotted number happens once per
 * cell, in `toDisplay`.
 */
export interface SeriesCell {
	bucket: string;
	seriesKey: string;
	seriesLabel: string;
	value: number;
}

export interface ChartSeries {
	key: string;
	label: string;
	color: string;
	/** Summed base-unit value across every bucket; what the default order sorts on. */
	total: number;
}

/**
 * Ordered palette for stacked series; cycles if there are more series than
 * colors. Danger-red sits last deliberately: on a spend or hours chart no series
 * is a failure, so a red segment among four calm ones reads as a problem the
 * chart is not reporting. Six calm hues run out later than the original five did
 * - a roster larger than that still repeats, which the legend disambiguates.
 */
const SERIES_COLORS = [
	'var(--color-accent)',
	'var(--color-success)',
	'var(--color-warning)',
	'var(--color-purple-soft-fg)',
	'var(--color-info)',
	'var(--color-pink-soft-fg)',
	'var(--color-danger)',
];

interface PivotedRow {
	bucket: string;
	label: string;
	[seriesKey: string]: string | number;
}

/**
 * The chart's series list: one entry per distinct `seriesKey`, ordered largest
 * total first so the biggest sits at the bottom of each stack.
 *
 * `preferredOrder` overrides that sort. A caller that renders its own list
 * beside the chart (the Hours tab's per-agent table) passes the order it uses,
 * so a row's swatch is always the colour of its segment - which a per-chart sort
 * cannot guarantee, since switching bucket size changes the totals it sorts on.
 * Keys absent from `preferredOrder` fall in behind it, still largest first.
 */
export function orderSeries(cells: SeriesCell[], preferredOrder?: string[]): ChartSeries[] {
	const totalByKey = new Map<string, { label: string; total: number }>();
	for (const c of cells) {
		const prev = totalByKey.get(c.seriesKey);
		totalByKey.set(c.seriesKey, {
			label: c.seriesLabel,
			total: (prev?.total ?? 0) + c.value,
		});
	}
	const rank = new Map((preferredOrder ?? []).map((key, i) => [key, i]));
	return [...totalByKey.entries()]
		.sort((a, b) => {
			const ra = rank.get(a[0]) ?? Number.POSITIVE_INFINITY;
			const rb = rank.get(b[0]) ?? Number.POSITIVE_INFINITY;
			if (ra !== rb) return ra - rb;
			return b[1].total - a[1].total;
		})
		.map(([key, v], i) => ({
			key,
			label: v.label,
			color: SERIES_COLORS[i % SERIES_COLORS.length],
			total: v.total,
		}));
}

/**
 * Pivot flat cells into one row per bucket with a plotted number per series.
 * Summing happens in base units so the arithmetic is exact; `toDisplay` converts
 * once, at the end.
 */
function pivot(
	cells: SeriesCell[],
	series: ChartSeries[],
	toDisplay: (value: number) => number,
	formatBucket: (bucket: string) => string,
): PivotedRow[] {
	const byBucket = new Map<string, Map<string, number>>();
	for (const c of cells) {
		let base = byBucket.get(c.bucket);
		if (!base) {
			base = new Map();
			byBucket.set(c.bucket, base);
		}
		base.set(c.seriesKey, (base.get(c.seriesKey) ?? 0) + c.value);
	}
	return [...byBucket.entries()]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([bucket, base]) => {
			const row: PivotedRow = { bucket, label: formatBucket(bucket) };
			for (const s of series) row[s.key] = toDisplay(base.get(s.key) ?? 0);
			return row;
		});
}

interface StackedSeriesChartProps {
	title?: string;
	cells: SeriesCell[] | undefined;
	isLoading: boolean;
	/**
	 * Base units -> the number plotted (cents -> dollars, seconds -> hours). Do
	 * not round here: `formatValue` reads the plotted number back, so a rounded
	 * plot value is a rounded tooltip.
	 */
	toDisplay: (value: number) => number;
	/**
	 * The **plotted** number -> the tooltip string, so it takes whatever unit
	 * `toDisplay` produced. Deliberately not the base unit: recovering that would
	 * mean reading recharts' own tooltip payload shape, which is not ours to
	 * depend on. Callers invert exactly (`Math.round(dollars * 100)`).
	 */
	formatValue: (value: number) => string;
	/** Bucket key -> x-axis label. Defaults to the key itself. */
	formatBucket?: (bucket: string) => string;
	/** See `orderSeries`. */
	seriesOrder?: string[];
	emptyText?: string;
	testId?: string;
}

/**
 * Per-bucket stacked chart with a bar/line toggle. Each series (agent, AI
 * adapter) is a stacked segment. Responsive: full-width, stacks on mobile,
 * legend wraps.
 */
export function StackedSeriesChart({
	title,
	cells,
	isLoading,
	toDisplay,
	formatValue,
	formatBucket,
	seriesOrder,
	emptyText = 'Nothing recorded.',
	testId = 'stacked-series-chart',
}: StackedSeriesChartProps) {
	const [kind, setKind] = useState<ChartKind>('bar');
	// Deliberately not memoized: the input is at most a few hundred cells, and a
	// dependency list over the caller's formatters would either re-run every
	// render anyway or go stale when one of them changes.
	const series = orderSeries(cells ?? [], seriesOrder);
	const rows = pivot(cells ?? [], series, toDisplay, formatBucket ?? ((bucket) => bucket));

	const tooltipFormatter = (value: unknown) => formatValue(Number(value));

	return (
		<div className="rounded-md border border-border bg-surface p-4">
			<div className={`mb-3 flex items-center gap-2 ${title ? 'justify-between' : 'justify-end'}`}>
				{title && <span className="text-[13px] font-medium text-text-1">{title}</span>}
				<div
					role="tablist"
					aria-label="Chart type"
					className="inline-flex rounded-md border border-border-subtle bg-surface-2 p-0.5 text-xs"
				>
					{(['bar', 'line'] as const).map((k) => (
						<button
							key={k}
							type="button"
							role="tab"
							aria-selected={kind === k}
							onClick={() => setKind(k)}
							className={`px-2.5 py-1 rounded capitalize ${
								kind === k ? 'bg-surface text-text-1 shadow-sm' : 'text-text-2 hover:text-text-1'
							}`}
						>
							{k}
						</button>
					))}
				</div>
			</div>

			{isLoading ? (
				<div className="h-[200px] flex items-center justify-center text-[13px] text-text-3">
					Loading…
				</div>
			) : rows.length === 0 ? (
				<div className="h-[200px] flex items-center justify-center text-[13px] text-text-3">
					{emptyText}
				</div>
			) : (
				<div className="h-[260px] w-full" data-testid={testId}>
					<ResponsiveContainer width="100%" height="100%">
						{kind === 'bar' ? (
							<BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
								<CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
								<XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="var(--color-text-3)" />
								<YAxis tick={{ fontSize: 11 }} stroke="var(--color-text-3)" />
								<Tooltip formatter={tooltipFormatter} contentStyle={{ fontSize: 12 }} />
								<Legend wrapperStyle={{ fontSize: 12 }} />
								{series.map((s) => (
									<Bar key={s.key} dataKey={s.key} name={s.label} stackId="stack" fill={s.color} />
								))}
							</BarChart>
						) : (
							<LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
								<CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
								<XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="var(--color-text-3)" />
								<YAxis tick={{ fontSize: 11 }} stroke="var(--color-text-3)" />
								<Tooltip formatter={tooltipFormatter} contentStyle={{ fontSize: 12 }} />
								<Legend wrapperStyle={{ fontSize: 12 }} />
								{series.map((s) => (
									<Line
										key={s.key}
										type="monotone"
										dataKey={s.key}
										name={s.label}
										stroke={s.color}
										strokeWidth={2}
										dot={false}
									/>
								))}
							</LineChart>
						)}
					</ResponsiveContainer>
				</div>
			)}
		</div>
	);
}
