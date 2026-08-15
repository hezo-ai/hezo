import { HoursBucket } from '@hezo/shared';
import { BarChart3, Users } from 'lucide-react';
import { useState } from 'react';
import {
	type AgentHours,
	type AgentHoursBucketPoint,
	type AgentHoursRow,
	useAgentHours,
} from '../../hooks/use-agent-hours';
import { formatDuration, hoursSpent, secondsToHours } from '../../lib/format-duration';
import { useI18n } from '../../lib/i18n';
import { agentDisplayName } from '../agent-identity-tooltip';
import { formatBucketLabel } from '../charts/chart-format';
import { orderSeries, type SeriesCell, StackedSeriesChart } from '../charts/stacked-series-chart';
import { SectionHeader } from '../ui/section-header';
import { SegmentedControl } from '../ui/segmented-control';

function label(agent: { agent_name: string | null; agent_title: string }): string {
	return agentDisplayName({ human_name: agent.agent_name, title: agent.agent_title });
}

function toCells(points: AgentHoursBucketPoint[] | undefined): SeriesCell[] {
	return (points ?? []).map((p) => ({
		bucket: p.bucket,
		seriesKey: p.agent_id,
		seriesLabel: label(p),
		value: p.seconds,
	}));
}

/** Whole-percent share of a total; 0 when there is nothing to divide by. */
function share(part: number, total: number): number {
	return total > 0 ? Math.round((part / total) * 100) : 0;
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
 * The Activity page's Hours tab: how long each agent spent working in this
 * project, bucketed by day, week or month.
 *
 * "Hours" is wall-clock run time, not billed time - the Budget page answers the
 * money question from the same runs. The chart and the table below it are
 * ordered identically (month-to-date, largest first) and share one palette, so a
 * row's swatch always names its own segment.
 */
export function AgentHoursPanel({ projectId }: { projectId: string }) {
	const { t } = useI18n();
	const [bucket, setBucket] = useState<HoursBucket>(HoursBucket.Day);
	const { data, isLoading } = useAgentHours(projectId, bucket);

	const agents = data?.agents ?? [];
	const totals = data?.totals;
	const cells = toCells(data?.buckets);
	// The table's order is the chart's order, so the two never disagree about
	// which colour belongs to whom.
	const seriesOrder = agents.map((a) => a.agent_id);
	const colorByAgent = new Map(orderSeries(cells, seriesOrder).map((s) => [s.key, s.color]));

	const chartTitle = {
		[HoursBucket.Day]: t('activity.hours.chart.day'),
		[HoursBucket.Week]: t('activity.hours.chart.week'),
		[HoursBucket.Month]: t('activity.hours.chart.month'),
	}[bucket];

	return (
		<div className="flex flex-col gap-6">
			<HoursTiles totals={totals} agents={agents} hasHistory={cells.length > 0} />

			<section>
				<SectionHeader
					icon={BarChart3}
					title={t('activity.hours.overTime.title')}
					description={t('activity.hours.overTime.description')}
				/>
				<div className="mb-3 flex justify-end">
					<SegmentedControl
						label={t('activity.hours.bucketLabel')}
						value={bucket}
						onChange={setBucket}
						testId="hours-bucket"
						className="w-full sm:w-auto"
						options={[
							{ value: HoursBucket.Day, label: t('activity.hours.bucket.day') },
							{ value: HoursBucket.Week, label: t('activity.hours.bucket.week') },
							{ value: HoursBucket.Month, label: t('activity.hours.bucket.month') },
						]}
					/>
				</div>
				<StackedSeriesChart
					title={chartTitle}
					cells={cells}
					isLoading={isLoading}
					toDisplay={secondsToHours}
					formatValue={hoursSpent}
					formatBucket={(key) => formatBucketLabel(key, bucket)}
					seriesOrder={seriesOrder}
					emptyText={t('activity.hours.empty')}
					testId="agent-hours-chart"
				/>
			</section>

			<section>
				<SectionHeader
					icon={Users}
					title={t('activity.hours.perAgent.title')}
					description={t('activity.hours.perAgent.description')}
				/>
				<AgentHoursTable
					agents={agents}
					totals={totals}
					colorByAgent={colorByAgent}
					isLoading={isLoading}
				/>
			</section>
		</div>
	);
}

/**
 * The summary row. Every tile is scoped to the current month, so on a project
 * that has never run one they would all read zero above two empty states -
 * `hasHistory` keeps them off that page. A project idle *this* month but busy
 * before still gets them: there the zeros are the finding, next to a chart that
 * shows what came before.
 */
function HoursTiles({
	totals,
	agents,
	hasHistory,
}: {
	totals: AgentHours['totals'] | undefined;
	agents: AgentHoursRow[];
	hasHistory: boolean;
}) {
	const { t, plural } = useI18n();
	if (!totals || (totals.month_runs === 0 && !hasHistory)) return null;

	const busiest = agents[0];
	const delta = totals.prev_week_seconds
		? Math.round(
				((totals.week_seconds - totals.prev_week_seconds) / totals.prev_week_seconds) * 100,
			)
		: null;
	const avgRun = totals.month_runs > 0 ? Math.round(totals.month_seconds / totals.month_runs) : 0;

	return (
		<div
			data-testid="agent-hours-tiles"
			className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5"
		>
			<Tile
				title={t('activity.hours.today')}
				value={formatDuration(totals.today_seconds)}
				meta={plural('activity.hours.activeAgents', totals.active_today)}
			/>
			<Tile
				title={t('activity.hours.thisWeek')}
				value={formatDuration(totals.week_seconds)}
				meta={
					delta == null
						? t('activity.hours.noPriorWeek')
						: t('activity.hours.weekDelta', { delta: `${delta >= 0 ? '+' : ''}${delta}` })
				}
			/>
			<Tile
				title={t('activity.hours.thisMonth')}
				value={formatDuration(totals.month_seconds)}
				meta={plural('thread.group.runs', totals.month_runs)}
			/>
			<Tile
				title={t('activity.hours.avgRun')}
				value={formatDuration(avgRun)}
				meta={t('activity.hours.monthToDate')}
			/>
			{busiest && (
				<Tile
					title={t('activity.hours.busiest')}
					value={label(busiest)}
					meta={formatDuration(busiest.month_seconds)}
				/>
			)}
		</div>
	);
}

/**
 * Per-agent breakdown. Runs and Avg run drop below `sm` - on a phone the three
 * windows are what the column is for, and six numeric columns would compress
 * past reading.
 */
function AgentHoursTable({
	agents,
	totals,
	colorByAgent,
	isLoading,
}: {
	agents: AgentHoursRow[];
	totals: AgentHours['totals'] | undefined;
	colorByAgent: Map<string, string>;
	isLoading: boolean;
}) {
	const { t } = useI18n();

	if (isLoading) {
		return (
			<div className="rounded-lg border border-border bg-surface p-4 shadow-xs">
				<p className="text-[13px] text-text-3">{t('common.loading')}</p>
			</div>
		);
	}
	if (agents.length === 0) {
		return (
			<div className="rounded-lg border border-border bg-surface p-4 shadow-xs">
				<p className="text-[13px] text-text-3">{t('activity.hours.empty')}</p>
			</div>
		);
	}

	const monthTotal = totals?.month_seconds ?? 0;
	const numeric = 'px-3 py-2 text-right font-mono text-[12.5px] tabular-nums text-text-1';
	const head =
		'px-3 pb-2 text-right text-[10.5px] font-semibold uppercase tracking-wide text-text-3';

	return (
		<div className="overflow-x-auto rounded-lg border border-border bg-surface shadow-xs">
			<table data-testid="agent-hours-table" className="w-full min-w-[420px] border-collapse">
				<thead>
					<tr className="border-b border-border">
						<th className={`${head} pl-4 text-left`}>{t('activity.hours.table.agent')}</th>
						<th className={head}>{t('activity.hours.today')}</th>
						<th className={head}>{t('activity.hours.bucket.week')}</th>
						<th className={head}>{t('activity.hours.bucket.month')}</th>
						<th className={`${head} hidden sm:table-cell`}>{t('activity.hours.table.runs')}</th>
						<th className={`${head} hidden sm:table-cell`}>{t('activity.hours.avgRun')}</th>
						<th className={`${head} hidden pr-4 lg:table-cell`}>
							{t('activity.hours.table.share')}
						</th>
					</tr>
				</thead>
				<tbody>
					{agents.map((agent) => {
						const pct = share(agent.month_seconds, monthTotal);
						const color = colorByAgent.get(agent.agent_id) ?? 'var(--color-accent)';
						return (
							<tr
								key={agent.agent_id}
								data-testid={`agent-hours-row-${agent.agent_slug ?? agent.agent_id}`}
								className="border-b border-border last:border-b-0"
							>
								<td className="py-2 pl-4 pr-3">
									<div className="flex min-w-0 items-center gap-2.5">
										<span
											aria-hidden
											style={{ background: color }}
											className="h-6 w-[3px] shrink-0 rounded-full"
										/>
										<div className="min-w-0">
											<div className="truncate text-[13px] font-medium text-text-1">
												{label(agent)}
											</div>
											{agent.agent_name?.trim() && (
												<div className="truncate text-[11px] text-text-3">{agent.agent_title}</div>
											)}
										</div>
									</div>
								</td>
								<td className={numeric}>{formatDuration(agent.today_seconds)}</td>
								<td className={numeric}>{formatDuration(agent.week_seconds)}</td>
								<td className={numeric}>{formatDuration(agent.month_seconds)}</td>
								<td className={`${numeric} hidden text-text-2 sm:table-cell`}>
									{agent.month_runs}
								</td>
								<td className={`${numeric} hidden text-text-2 sm:table-cell`}>
									{formatDuration(
										agent.month_runs > 0 ? Math.round(agent.month_seconds / agent.month_runs) : 0,
									)}
								</td>
								<td className={`${numeric} hidden pr-4 lg:table-cell`}>
									<span className="flex items-center justify-end gap-2">
										<span className="h-1.5 w-[74px] shrink-0 overflow-hidden rounded-full bg-surface-3">
											<span
												className="block h-full rounded-full"
												style={{ width: `${pct}%`, background: color }}
											/>
										</span>
										<span className="w-8 text-right text-text-3">{pct}%</span>
									</span>
								</td>
							</tr>
						);
					})}
				</tbody>
				{totals && (
					<tfoot>
						<tr className="border-t border-border-strong">
							<td className="py-2 pl-4 pr-3 text-[13px] font-semibold text-text-1">
								{t('activity.hours.table.total')}
							</td>
							<td className={`${numeric} font-semibold`}>{formatDuration(totals.today_seconds)}</td>
							<td className={`${numeric} font-semibold`}>{formatDuration(totals.week_seconds)}</td>
							<td className={`${numeric} font-semibold`}>{formatDuration(totals.month_seconds)}</td>
							<td className={`${numeric} hidden font-semibold sm:table-cell`}>
								{totals.month_runs}
							</td>
							<td className={`${numeric} hidden font-semibold sm:table-cell`}>
								{formatDuration(
									totals.month_runs > 0 ? Math.round(totals.month_seconds / totals.month_runs) : 0,
								)}
							</td>
							<td className="hidden lg:table-cell" />
						</tr>
					</tfoot>
				)}
			</table>
		</div>
	);
}
