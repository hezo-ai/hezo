import { AgentAdminStatus, centsToDollars, GoalHealth, type GoalWithProject } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useAgents } from '../../hooks/use-agents';
import { useBudgetStatus } from '../../hooks/use-costs';
import { useProjectMeta } from '../../hooks/use-projects';
import { useI18n } from '../../lib/i18n';

/**
 * The metric strip across the top of the project dashboard: the five numbers that answer "what is
 * the state of this project" before any prose is read.
 *
 * Every tile reads from a query the page below it already needs, so the strip costs no extra
 * request - it is a second projection of the same data, not a second fetch.
 *
 * Each tile is a link to the page that owns its number, so the strip doubles as the route into
 * whatever it just reported. The two tiles HQ drops (goals, spend) are also the two pages HQ's
 * sidebar hides, so no tile ever points at a page the project does not have.
 */
/**
 * Where a tile sends you: the page that owns the number it reports. Every one of them is scoped by
 * `projectId` alone, so the tile needs no per-target params.
 */
type MetricTarget =
	| '/projects/$projectId/inbox'
	| '/projects/$projectId/budget/team'
	| '/projects/$projectId/tasks'
	| '/projects/$projectId/goals'
	| '/projects/$projectId/budget';

function Metric({
	label,
	value,
	detail,
	valueClass,
	children,
	testId,
	projectId,
	to,
}: {
	label: string;
	value: string;
	/** Small qualifier beside the number ("of 4", "2 in review"). */
	detail?: string;
	detailClass?: string;
	valueClass?: string;
	/** Rendered under the value - the month-spend tile's cap bar. */
	children?: ReactNode;
	testId: string;
	projectId: string;
	/** The page this tile's number is reported on. */
	to: MetricTarget;
}) {
	return (
		<Link
			to={to}
			params={{ projectId }}
			className="block bg-surface px-3 py-2.5 outline-none transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:px-4"
			data-testid={testId}
		>
			<p className="font-mono text-[10px] uppercase tracking-wider text-text-3">{label}</p>
			<p className="mt-0.5 flex items-baseline gap-1.5">
				<span
					className={`text-xl font-semibold tabular-nums tracking-tight ${valueClass ?? 'text-text-1'}`}
					data-testid={`${testId}-value`}
				>
					{value}
				</span>
				{detail && <span className="text-[11px] text-text-3">{detail}</span>}
			</p>
			{children}
		</Link>
	);
}

/** Mean completion across a project's active goals, rounded, as the strip's goal tile. */
function goalRollup(goals: GoalWithProject[]): { percent: number; offTrack: number } | null {
	const active = goals.filter((g) => !g.archived_at);
	if (active.length === 0) return null;
	const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
	return {
		percent: clamp(active.reduce((sum, g) => sum + clamp(g.progress_percent), 0) / active.length),
		offTrack: active.filter((g) => g.health === GoalHealth.OffTrack).length,
	};
}

export function DashboardMetrics({
	projectId,
	goals,
	actionCount,
	isInternal,
}: {
	projectId: string;
	goals: GoalWithProject[];
	actionCount: number;
	/** HQ has neither goals nor a budget, so those two tiles are dropped rather than shown empty. */
	isInternal: boolean;
}) {
	const { t, formatMoney } = useI18n();
	const project = useProjectMeta(projectId);
	const { data: agents } = useAgents(projectId, AgentAdminStatus.Enabled);
	const { data: budget } = useBudgetStatus(projectId, { enabled: !isInternal });
	const roster = agents ?? [];
	const running = roster.filter((a) => a.active_run?.run_status === 'running').length;
	const rollup = goalRollup(goals);
	const monthly = budget?.project.monthly;

	const tiles: ReactNode[] = [
		<Metric
			key="needs-you"
			testId="dashboard-metric-needs-you"
			projectId={projectId}
			to="/projects/$projectId/inbox"
			label={t('dashboard.metric.needsYou')}
			value={String(actionCount)}
			valueClass={actionCount > 0 ? 'text-accent' : 'text-text-1'}
		/>,
		<Metric
			key="active-agents"
			testId="dashboard-metric-active-agents"
			projectId={projectId}
			to="/projects/$projectId/budget/team"
			label={t('dashboard.metric.activeAgents')}
			value={String(running)}
			detail={t('dashboard.metric.ofRoster', { count: roster.length })}
			valueClass={running > 0 ? 'text-live' : 'text-text-1'}
		/>,
		<Metric
			key="open-tasks"
			testId="dashboard-metric-open-tasks"
			projectId={projectId}
			to="/projects/$projectId/tasks"
			label={t('dashboard.metric.openTasks')}
			value={String(project?.open_task_count ?? 0)}
		/>,
	];

	if (!isInternal) {
		tiles.push(
			<Metric
				key="goals"
				testId="dashboard-metric-goals"
				projectId={projectId}
				to="/projects/$projectId/goals"
				label={t('dashboard.metric.goalProgress')}
				value={rollup ? `${rollup.percent}%` : '-'}
				detail={
					rollup && rollup.offTrack > 0
						? t('dashboard.metric.offTrack', { count: rollup.offTrack })
						: undefined
				}
			/>,
			<Metric
				key="spend"
				testId="dashboard-metric-spend"
				projectId={projectId}
				to="/projects/$projectId/budget"
				label={t('dashboard.metric.monthSpend')}
				value={monthly ? formatMoney(monthly.spentCents) : '-'}
				detail={
					monthly && monthly.limitCents > 0
						? t('dashboard.metric.ofCap', { amount: `$${centsToDollars(monthly.limitCents)}` })
						: undefined
				}
				valueClass={monthly?.overBudget ? 'text-danger' : 'text-text-1'}
			>
				{monthly && monthly.limitCents > 0 && (
					<div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-3">
						<div
							className={`h-full rounded-full ${monthly.overBudget ? 'bg-danger' : 'bg-success'}`}
							style={{
								width: `${Math.min(100, Math.round((monthly.spentCents / monthly.limitCents) * 100))}%`,
							}}
						/>
					</div>
				)}
			</Metric>,
		);
	}

	// Two columns on a phone, then one per tile from `sm` up. The gap is a 1px border colour
	// showing through, which is how the rest of the app draws a segmented strip.
	return (
		<section
			data-testid="dashboard-metrics"
			className={`grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3 ${
				isInternal ? 'lg:grid-cols-3' : 'lg:grid-cols-5'
			}`}
		>
			{tiles}
		</section>
	);
}
