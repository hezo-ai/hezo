import { useState } from 'react';
import {
	Bar,
	BarChart,
	CartesianGrid,
	Line,
	LineChart,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from 'recharts';
import { type DailyCostPoint, useDailyCostSeries } from '../../hooks/use-costs';
import { dollars, formatDay } from './chart-format';

type ChartKind = 'bar' | 'line';

interface ChartDatum {
	day: string;
	label: string;
	dollars: number;
}

function toData(points: DailyCostPoint[] | undefined): ChartDatum[] {
	return (points ?? []).map((p) => ({
		day: p.day,
		label: formatDay(p.day),
		dollars: Number((p.total_cents / 100).toFixed(2)),
	}));
}

/**
 * Per-day spend chart with a bar/line toggle. Scoped to the project, or to a
 * single agent when `agentId` is set. Responsive: full-width and stacked on
 * mobile, the toggle wraps above the chart.
 */
export function BudgetCharts({
	projectId,
	agentId,
	title,
}: {
	projectId: string;
	agentId?: string;
	title?: string;
}) {
	const [kind, setKind] = useState<ChartKind>('bar');
	const { data, isLoading } = useDailyCostSeries(
		projectId,
		agentId ? { agent_id: agentId } : undefined,
	);
	const chartData = toData(data?.summary);

	return (
		<div className="rounded-radius-md border border-border bg-bg p-4">
			<div className={`mb-3 flex items-center gap-2 ${title ? 'justify-between' : 'justify-end'}`}>
				{title && <span className="text-[13px] font-medium text-text">{title}</span>}
				<div
					role="tablist"
					aria-label="Chart type"
					className="inline-flex rounded-md border border-border-subtle bg-bg-subtle p-0.5 text-xs"
				>
					{(['bar', 'line'] as const).map((k) => (
						<button
							key={k}
							type="button"
							role="tab"
							aria-selected={kind === k}
							onClick={() => setKind(k)}
							className={`px-2.5 py-1 rounded capitalize ${
								kind === k ? 'bg-bg text-text shadow-sm' : 'text-text-muted hover:text-text'
							}`}
						>
							{k}
						</button>
					))}
				</div>
			</div>

			{isLoading ? (
				<div className="h-[200px] flex items-center justify-center text-[13px] text-text-subtle">
					Loading…
				</div>
			) : chartData.length === 0 ? (
				<div className="h-[200px] flex items-center justify-center text-[13px] text-text-subtle">
					No spend recorded.
				</div>
			) : (
				<div className="h-[220px] w-full" data-testid="budget-chart">
					<ResponsiveContainer width="100%" height="100%">
						{kind === 'bar' ? (
							<BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
								<CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
								<XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="var(--color-text-subtle)" />
								<YAxis tick={{ fontSize: 11 }} stroke="var(--color-text-subtle)" />
								<Tooltip
									formatter={(value) => dollars(Math.round(Number(value) * 100))}
									contentStyle={{ fontSize: 12 }}
								/>
								<Bar dataKey="dollars" fill="var(--color-accent-blue)" radius={[2, 2, 0, 0]} />
							</BarChart>
						) : (
							<LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
								<CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
								<XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="var(--color-text-subtle)" />
								<YAxis tick={{ fontSize: 11 }} stroke="var(--color-text-subtle)" />
								<Tooltip
									formatter={(value) => dollars(Math.round(Number(value) * 100))}
									contentStyle={{ fontSize: 12 }}
								/>
								<Line
									type="monotone"
									dataKey="dollars"
									stroke="var(--color-accent-blue)"
									strokeWidth={2}
									dot={false}
								/>
							</LineChart>
						)}
					</ResponsiveContainer>
				</div>
			)}
		</div>
	);
}
