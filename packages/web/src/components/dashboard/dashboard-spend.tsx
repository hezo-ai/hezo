import { centsToDollars } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { DollarSign } from 'lucide-react';
import { useId } from 'react';
import { useBudgetStatus, useDailyCostSeries } from '../../hooks/use-costs';
import { useI18n } from '../../lib/i18n';
import { Card } from '../ui/card';

/** Days of history the sparkline draws. Older spend is the Budget page's business. */
const SPARK_DAYS = 14;
const SPARK_W = 200;
const SPARK_H = 40;

/**
 * Daily spend as an area sparkline. Drawn inline rather than through a chart library: it carries
 * no axes, legend or interaction, so a path and a fill is the whole thing.
 *
 * Returns null below two points - a single day is a dot, not a trend, and a flat line drawn from
 * one value reads as "no spend" when it means "one day of history".
 */
function SpendSparkline({ points }: { points: number[] }) {
	const gradientId = useId();
	if (points.length < 2) return null;

	const max = Math.max(...points, 1);
	const step = SPARK_W / (points.length - 1);
	const coords = points.map((cents, i) => {
		const x = Math.round(i * step * 100) / 100;
		// 2px of headroom so the peak's stroke is not clipped by the viewBox edge.
		const y = Math.round((SPARK_H - 2 - (cents / max) * (SPARK_H - 4)) * 100) / 100;
		return [x, y] as const;
	});
	const line = coords.map(([x, y]) => `${x},${y}`).join(' L');
	const last = coords[coords.length - 1];

	return (
		<svg
			viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
			preserveAspectRatio="none"
			className="my-2 block h-10 w-full"
			role="img"
			aria-label={`Daily spend over the last ${points.length} days`}
			data-testid="dashboard-spend-sparkline"
		>
			<title>{`Daily spend over the last ${points.length} days`}</title>
			<defs>
				<linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
					<stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.22" />
					<stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
				</linearGradient>
			</defs>
			<path d={`M${line} L${SPARK_W},${SPARK_H} L0,${SPARK_H} Z`} fill={`url(#${gradientId})`} />
			<path
				d={`M${line}`}
				fill="none"
				stroke="var(--color-accent)"
				strokeWidth="1.5"
				vectorEffect="non-scaling-stroke"
			/>
			<circle cx={last[0]} cy={last[1]} r="2.5" fill="var(--color-accent)" />
		</svg>
	);
}

/**
 * Month-to-date spend with a daily sparkline and the three other windows beneath it.
 *
 * The series and the all-time total come from one `group_by=day` request: the ungrouped form of
 * the same endpoint returns every cost row on the project, which is an unbounded response to
 * render one number with.
 */
export function DashboardSpend({ projectId }: { projectId: string }) {
	const { t, formatMoney } = useI18n();
	const { data: budget } = useBudgetStatus(projectId);
	const { data: costs } = useDailyCostSeries(projectId);

	const monthly = budget?.project.monthly;
	const daily = (costs?.summary ?? []).slice(-SPARK_DAYS).map((point) => point.total_cents);

	return (
		<section data-testid="dashboard-spend">
			<div className="mb-2 flex items-center gap-2">
				<DollarSign className="h-4 w-4 shrink-0 text-text-3" aria-hidden="true" />
				<h2 className="text-[12.5px] font-medium text-text-1">{t('dashboard.spend.heading')}</h2>
				<Link
					to="/projects/$projectId/budget"
					params={{ projectId }}
					className="ml-auto text-[11px] text-info-soft-fg hover:underline"
				>
					{t('nav.budget')}
				</Link>
			</div>
			<Card>
				<div className="flex items-baseline justify-between gap-3">
					<span
						className={`font-mono text-xl font-semibold tabular-nums tracking-tight ${
							monthly?.overBudget ? 'text-danger' : 'text-text-1'
						}`}
						data-testid="dashboard-spend-month"
					>
						{formatMoney(monthly?.spentCents ?? 0)}
					</span>
					<span className="text-[11px] text-text-3">
						{monthly && monthly.limitCents > 0
							? t('dashboard.spend.ofCapThisMonth', {
									amount: `$${centsToDollars(monthly.limitCents)}`,
								})
							: t('dashboard.spend.thisMonth')}
					</span>
				</div>
				<SpendSparkline points={daily} />
				<div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-3">
					<span>
						{t('dashboard.spend.today')}{' '}
						<b className="font-mono font-medium tabular-nums text-text-1">
							{formatMoney(budget?.project.daily.spentCents ?? 0)}
						</b>
					</span>
					<span>
						{t('dashboard.spend.week')}{' '}
						<b className="font-mono font-medium tabular-nums text-text-1">
							{formatMoney(budget?.project.weekly.spentCents ?? 0)}
						</b>
					</span>
					<span>
						{t('dashboard.spend.allTime')}{' '}
						<b className="font-mono font-medium tabular-nums text-text-1">
							{formatMoney(costs?.total_cents ?? 0)}
						</b>
					</span>
				</div>
			</Card>
		</section>
	);
}
