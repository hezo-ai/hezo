import { useMemo, useState } from 'react';
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
import { dollars, formatDay } from './chart-format';

type ChartKind = 'bar' | 'line';

/** A single (day, series) spend cell. `seriesKey` is the stable id; `seriesLabel` is shown. */
export interface SpendCell {
	day: string;
	seriesKey: string;
	seriesLabel: string;
	total_cents: number;
}

// Ordered palette for stacked series; cycles if there are more series than colors.
const SERIES_COLORS = [
	'var(--color-accent)',
	'var(--color-success)',
	'var(--color-warning)',
	'var(--color-purple-soft-fg)',
	'var(--color-danger)',
];

interface PivotedRow {
	day: string;
	label: string;
	[seriesKey: string]: string | number;
}

interface Series {
	key: string;
	label: string;
	color: string;
}

/**
 * Pivot flat (day, series) cells into one row per day with a numeric (dollars)
 * field per series, plus the ordered series list for the legend / stacks.
 * Series are ordered by total spend desc so the largest sits at the bottom.
 */
function pivot(cells: SpendCell[]): { rows: PivotedRow[]; series: Series[] } {
	const totalByKey = new Map<string, { label: string; total: number }>();
	for (const c of cells) {
		const prev = totalByKey.get(c.seriesKey);
		totalByKey.set(c.seriesKey, {
			label: c.seriesLabel,
			total: (prev?.total ?? 0) + c.total_cents,
		});
	}
	const series: Series[] = [...totalByKey.entries()]
		.sort((a, b) => b[1].total - a[1].total)
		.map(([key, v], i) => ({
			key,
			label: v.label,
			color: SERIES_COLORS[i % SERIES_COLORS.length],
		}));

	const byDay = new Map<string, PivotedRow>();
	for (const c of cells) {
		let row = byDay.get(c.day);
		if (!row) {
			row = { day: c.day, label: formatDay(c.day) };
			for (const s of series) row[s.key] = 0;
			byDay.set(c.day, row);
		}
		row[c.seriesKey] = Number(
			((Number(row[c.seriesKey] ?? 0) as number) + c.total_cents / 100).toFixed(2),
		);
	}
	const rows = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
	return { rows, series };
}

/**
 * Per-day stacked spend chart with a bar/line toggle. Each series (agent or AI
 * adapter config) is a stacked segment. Responsive: full-width, stacks on mobile,
 * legend wraps.
 */
export function StackedSpendChart({
	title,
	cells,
	isLoading,
}: {
	title?: string;
	cells: SpendCell[] | undefined;
	isLoading: boolean;
}) {
	const [kind, setKind] = useState<ChartKind>('bar');
	const { rows, series } = useMemo(() => pivot(cells ?? []), [cells]);

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
					No spend recorded.
				</div>
			) : (
				<div className="h-[260px] w-full" data-testid="stacked-spend-chart">
					<ResponsiveContainer width="100%" height="100%">
						{kind === 'bar' ? (
							<BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
								<CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
								<XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="var(--color-text-3)" />
								<YAxis tick={{ fontSize: 11 }} stroke="var(--color-text-3)" />
								<Tooltip
									formatter={(value) => dollars(Math.round(Number(value) * 100))}
									contentStyle={{ fontSize: 12 }}
								/>
								<Legend wrapperStyle={{ fontSize: 12 }} />
								{series.map((s) => (
									<Bar key={s.key} dataKey={s.key} name={s.label} stackId="spend" fill={s.color} />
								))}
							</BarChart>
						) : (
							<LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
								<CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
								<XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="var(--color-text-3)" />
								<YAxis tick={{ fontSize: 11 }} stroke="var(--color-text-3)" />
								<Tooltip
									formatter={(value) => dollars(Math.round(Number(value) * 100))}
									contentStyle={{ fontSize: 12 }}
								/>
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
