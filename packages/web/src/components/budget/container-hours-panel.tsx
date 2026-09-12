import { HoursBucket } from '@hezo/shared';
import { BarChart3, Clock } from 'lucide-react';
import { useState } from 'react';
import {
	type ContainerHoursBucket,
	type ContainerHoursProjectBucket,
	type ContainerHoursTotals,
	useInstanceContainerHours,
	useProjectContainerHours,
} from '../../hooks/use-container-hours';
import { formatDuration, hoursSpent, secondsToHours } from '../../lib/format-duration';
import { useI18n } from '../../lib/i18n';
import { formatBucketLabel } from '../charts/chart-format';
import { type SeriesCell, StackedSeriesChart } from '../charts/stacked-series-chart';
import { ManagedSetting } from '../settings/managed-setting';
import { BudgetBar } from '../ui/budget-bar';
import { SectionHeader } from '../ui/section-header';
import { SegmentedControl } from '../ui/segmented-control';
import { MonthlyHoursCap } from './monthly-hours-cap';

const HOURS_KEY = 'hours';

/**
 * One project's buckets as a single uptime series - containers are shared by
 * task runs and chat turns alike, so there is no per-workload split to draw.
 *
 * One series rather than stacked-by-container: a container id means nothing to
 * an operator and there are as many of them as the fleet has churned through,
 * so a legend keyed on them would be unreadable and unstable between refreshes.
 */
function toScopeCells(buckets: ContainerHoursBucket[] | undefined, label: string): SeriesCell[] {
	// The series carries every bucket in the window, quiet ones included, so the
	// axis stays continuous across a gap. When they are ALL quiet there is no gap
	// to bridge and no axis worth drawing: emit nothing, and the chart says so in
	// words instead of rendering a row of zero-height bars.
	if (!(buckets ?? []).some((b) => b.seconds > 0)) return [];
	return (buckets ?? []).map((b) => ({
		bucket: b.bucket,
		seriesKey: HOURS_KEY,
		seriesLabel: label,
		value: b.seconds,
	}));
}

/** The instance series, one segment per project. */
function toProjectCells(rows: ContainerHoursProjectBucket[] | undefined): SeriesCell[] {
	// No guard needed here: the instance query inner-joins, so a quiet window
	// yields no rows at all rather than a row of zeroes.
	return (rows ?? []).map((r) => ({
		bucket: r.bucket,
		// A deleted project's hours share one key, so they aggregate into one
		// segment instead of one per orphaned row.
		seriesKey: r.project_id ?? 'deleted',
		seriesLabel: r.project_name,
		value: r.seconds,
	}));
}

/** A summary figure with its own caption. */
function Tile({ title, value, meta }: { title: string; value: string; meta: string }) {
	return (
		<div className="flex flex-col gap-0.5 rounded-lg border border-border bg-surface p-3.5 shadow-xs">
			<span className="text-[10.5px] font-semibold uppercase tracking-wide text-text-3">
				{title}
			</span>
			<span className="font-mono text-[22px] font-semibold leading-tight tracking-[-0.02em] text-text-1 tabular-nums">
				{value}
			</span>
			<span className="text-[11.5px] text-text-3">{meta}</span>
		</div>
	);
}

/**
 * Month-to-date hours against the allowance.
 *
 * Rendered only where there is an allowance to be against. With none set the
 * month figure is already a tile above, and a bar with no ceiling is a bar that
 * can only ever read empty.
 */
function AllowanceHero({ totals, capHours }: { totals: ContainerHoursTotals; capHours: number }) {
	const { t } = useI18n();
	const usedHours = totals.month_seconds / 3600;
	const remaining = Math.max(0, capHours - usedHours);
	return (
		<div
			data-testid="container-hours-allowance"
			className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 shadow-xs"
		>
			<div className="flex items-baseline justify-between gap-2">
				<span className="text-[13px] text-text-2">{t('budget.hours.allowance.title')}</span>
				<span className="font-mono text-[13px] text-text-1 tabular-nums">
					{t('budget.hours.allowance.used', {
						used: usedHours.toFixed(1),
						cap: String(capHours),
					})}
				</span>
			</div>
			<BudgetBar used={totals.month_seconds} total={capHours * 3600} />
			<span className="text-[11.5px] text-text-3">
				{t('budget.hours.allowance.remaining', { hours: remaining.toFixed(1) })}
			</span>
		</div>
	);
}

function HoursTiles({ totals }: { totals: ContainerHoursTotals }) {
	const { t, plural } = useI18n();
	const delta = totals.prev_month_seconds
		? Math.round(
				((totals.month_seconds - totals.prev_month_seconds) / totals.prev_month_seconds) * 100,
			)
		: null;
	return (
		<div data-testid="container-hours-tiles" className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
			<Tile
				title={t('budget.hours.today')}
				value={formatDuration(totals.today_seconds)}
				meta={plural('budget.hours.runningNow', totals.open_intervals)}
			/>
			<Tile
				title={t('budget.hours.thisWeek')}
				value={formatDuration(totals.week_seconds)}
				meta={t('budget.hours.rollingWindow')}
			/>
			<Tile
				title={t('budget.hours.thisMonth')}
				value={formatDuration(totals.month_seconds)}
				meta={
					delta == null
						? t('budget.hours.noPriorMonth')
						: t('budget.hours.monthDelta', { delta: `${delta >= 0 ? '+' : ''}${delta}` })
				}
			/>
		</div>
	);
}

/** The bucket-size control and the chart under it, shared by both scopes. */
function HoursChart({
	bucket,
	setBucket,
	cells,
	isLoading,
	title,
	testId,
}: {
	bucket: HoursBucket;
	setBucket: (b: HoursBucket) => void;
	cells: SeriesCell[];
	isLoading: boolean;
	title: string;
	testId: string;
}) {
	const { t } = useI18n();
	return (
		<section>
			<SectionHeader
				icon={BarChart3}
				title={t('budget.hours.overTime.title')}
				description={t('budget.hours.overTime.description')}
			/>
			<div className="mb-3 flex justify-end">
				<SegmentedControl
					label={t('budget.hours.bucketLabel')}
					value={bucket}
					onChange={setBucket}
					testId="container-hours-bucket"
					className="w-full sm:w-auto"
					options={[
						{ value: HoursBucket.Day, label: t('budget.hours.bucket.day') },
						{ value: HoursBucket.Week, label: t('budget.hours.bucket.week') },
						{ value: HoursBucket.Month, label: t('budget.hours.bucket.month') },
					]}
				/>
			</div>
			<StackedSeriesChart
				title={title}
				cells={cells}
				isLoading={isLoading}
				toDisplay={secondsToHours}
				formatValue={hoursSpent}
				formatBucket={(key) => formatBucketLabel(key, bucket)}
				emptyText={t('budget.hours.empty')}
				testId={testId}
			/>
		</section>
	);
}

/**
 * The Budget page's Hours tab, project scope: how long this project's
 * containers were up. Task runs and chat turns share the same containers, so
 * uptime is one series, not a per-workload split.
 *
 * **Not the same question as the Spend tab, and not the same as run time.** Spend
 * answers what the agents cost in tokens; this answers what the containers cost
 * in uptime, which is billed per hour on a managed backend whether an agent is
 * mid-run, mid-build or warm and idle between runs.
 */
export function ProjectContainerHoursPanel({ projectId }: { projectId: string }) {
	const { t } = useI18n();
	const [bucket, setBucket] = useState<HoursBucket>(HoursBucket.Day);
	const { data, isLoading } = useProjectContainerHours(projectId, bucket);
	const totals = data?.totals;

	return (
		<div className="flex flex-col gap-6">
			{totals && <HoursTiles totals={totals} />}
			<HoursChart
				bucket={bucket}
				setBucket={setBucket}
				cells={toScopeCells(data?.buckets, t('budget.hours.series.uptime'))}
				isLoading={isLoading}
				title={t('budget.hours.chart.project')}
				testId="container-hours-chart"
			/>
		</div>
	);
}

/**
 * The instance scope, split by project - the view HQ gets, and the only one that
 * can show the allowance, since the allowance is instance-wide.
 */
export function InstanceContainerHoursPanel() {
	const { t } = useI18n();
	const [bucket, setBucket] = useState<HoursBucket>(HoursBucket.Day);
	const { data, isLoading } = useInstanceContainerHours(bucket);
	const totals = data?.totals;
	const capHours = data?.monthly_hours ?? 0;

	return (
		<div className="flex flex-col gap-6">
			{totals && <HoursTiles totals={totals} />}
			{totals && capHours > 0 && <AllowanceHero totals={totals} capHours={capHours} />}
			<HoursChart
				bucket={bucket}
				setBucket={setBucket}
				cells={toProjectCells(data?.by_project)}
				isLoading={isLoading}
				title={t('budget.hours.chart.instance')}
				testId="container-hours-chart"
			/>
			{/* The cap gates container starts instance-wide, so it belongs to this
			    scope alone - and only where an hour costs something. */}
			{data?.metered && (
				<ManagedSetting pinned={data.monthly_hours_pinned}>
					<MonthlyHoursCap monthlyHours={capHours} />
				</ManagedSetting>
			)}
			{data && !data.metered && (
				<div className="flex items-start gap-2.5 rounded-lg border border-border bg-surface p-4 shadow-xs">
					<Clock className="mt-0.5 h-4 w-4 shrink-0 text-text-3" aria-hidden />
					<p className="text-[13px] text-text-2">{t('budget.hours.notMetered')}</p>
				</div>
			)}
		</div>
	);
}
