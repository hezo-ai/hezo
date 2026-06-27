import { type GoalHealth, GoalHealth as GoalHealthEnum, type GoalHistoryPoint } from '@hezo/shared';
import { useMemo } from 'react';
import {
	CartesianGrid,
	Line,
	LineChart,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from 'recharts';

interface GoalProgressChartProps {
	history: GoalHistoryPoint[];
	/** 'compact' = small inline line (no axes); 'full' = axes + grid + tooltip. */
	size?: 'compact' | 'full';
}

/** Line colour reflecting the latest health snapshot. */
const HEALTH_STROKE: Record<GoalHealth, string> = {
	[GoalHealthEnum.Pending]: 'var(--color-text-3)',
	[GoalHealthEnum.OnTrack]: 'var(--color-success)',
	[GoalHealthEnum.AtRisk]: 'var(--color-warning)',
	[GoalHealthEnum.OffTrack]: 'var(--color-danger)',
};

interface ChartDatum {
	t: string;
	label: string;
	percent: number;
}

function formatTime(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * A line chart of a goal's progress over time. Degrades gracefully: 0 points
 * renders a muted placeholder, 1 point renders a single dot. The line colour
 * follows the latest health snapshot.
 */
export function GoalProgressChart({ history, size = 'compact' }: GoalProgressChartProps) {
	const data = useMemo<ChartDatum[]>(
		() =>
			[...history]
				.sort((a, b) => a.t.localeCompare(b.t))
				.map((p) => ({ t: p.t, label: formatTime(p.t), percent: p.percent })),
		[history],
	);

	const stroke = useMemo(() => {
		const latest = data.length > 0 ? history[history.length - 1]?.health : undefined;
		return (latest && HEALTH_STROKE[latest]) || 'var(--color-accent)';
	}, [data.length, history]);

	const compact = size === 'compact';
	const heightClass = compact ? 'h-16' : 'h-[200px]';

	if (data.length === 0) {
		return (
			<div
				className={`${heightClass} w-full flex items-center justify-center rounded-md border border-border-subtle bg-surface-2 text-[11px] text-text-3`}
				data-testid="goal-progress-empty"
			>
				No history yet
			</div>
		);
	}

	// A single point can't draw a line; render it as a dot so the panel still
	// communicates "one snapshot so far".
	const singlePoint = data.length === 1;

	return (
		<div className={`${heightClass} w-full`} data-testid="goal-progress-chart">
			<ResponsiveContainer width="100%" height="100%">
				<LineChart
					data={data}
					margin={
						compact
							? { top: 4, right: 4, bottom: 4, left: 4 }
							: { top: 8, right: 8, bottom: 0, left: -16 }
					}
				>
					{!compact && <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />}
					{!compact && (
						<XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="var(--color-text-3)" />
					)}
					{!compact && (
						<YAxis
							domain={[0, 100]}
							tick={{ fontSize: 11 }}
							stroke="var(--color-text-3)"
							unit="%"
						/>
					)}
					{compact && <YAxis domain={[0, 100]} hide />}
					{!compact && (
						<Tooltip
							formatter={(value) => `${Math.round(Number(value))}%`}
							contentStyle={{ fontSize: 12 }}
						/>
					)}
					<Line
						type="monotone"
						dataKey="percent"
						stroke={stroke}
						strokeWidth={2}
						dot={singlePoint ? { r: 3, fill: stroke } : false}
						isAnimationActive={false}
					/>
				</LineChart>
			</ResponsiveContainer>
		</div>
	);
}
