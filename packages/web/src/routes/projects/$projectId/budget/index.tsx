import { HoursBucket } from '@hezo/shared';
import { createFileRoute, Link } from '@tanstack/react-router';
import { BarChart3, Pencil, Users } from 'lucide-react';
import { agentDisplayName } from '../../../../components/agent-identity-tooltip';
import { agentPageParams } from '../../../../components/agent-link';
import { AgentRef } from '../../../../components/agent-ref';
import { BudgetCharts } from '../../../../components/budget/budget-charts';
import { ProjectBudgetPanel } from '../../../../components/budget/project-budget-panel';
import { SubscriptionUsagePanel } from '../../../../components/budget/subscription-usage-panel';
import { formatDay } from '../../../../components/charts/chart-format';
import {
	type SeriesCell,
	StackedSeriesChart,
} from '../../../../components/charts/stacked-series-chart';
import { Avatar, getInitials } from '../../../../components/ui/avatar';
import { Badge } from '../../../../components/ui/badge';
import { BudgetBar } from '../../../../components/ui/budget-bar';
import { SectionHeader } from '../../../../components/ui/section-header';
import { useAgentHours } from '../../../../hooks/use-agent-hours';
import {
	type AdapterDailyUsagePoint,
	type AgentDailyUsagePoint,
	type EntityBudgetStatus,
	useAdapterDailyUsageSeries,
	useAgentDailyUsageSeries,
	useBudgetStatus,
	type WindowStatus,
} from '../../../../hooks/use-usage';
import { agentAvatarUrl } from '../../../../lib/agent-avatar';
import { formatDuration } from '../../../../lib/format-duration';
import { useI18n } from '../../../../lib/i18n';

/** A single window's tokens vs. limit with a fill bar. A 0 limit renders "∞". */
function WindowRow({ label, status }: { label: string; status: WindowStatus }) {
	const { formatCompact } = useI18n();
	const unlimited = status.limitTokens === 0;
	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center justify-between text-[13px]">
				<span className="text-text-2">{label}</span>
				<span className={`font-mono ${status.overBudget ? 'text-danger' : 'text-text-1'}`}>
					{formatCompact(status.usedTokens)}
					{unlimited ? (
						<span className="text-text-3"> / ∞</span>
					) : (
						<span className="text-text-3"> / {formatCompact(status.limitTokens)}</span>
					)}
				</span>
			</div>
			{!unlimited && <BudgetBar used={status.usedTokens} total={status.limitTokens} />}
		</div>
	);
}

function WindowGrid({ status }: { status: EntityBudgetStatus }) {
	const { t } = useI18n();
	return (
		<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
			<WindowRow label={t('budget.usage.today')} status={status.daily} />
			<WindowRow label={t('budget.usage.thisWeek')} status={status.weekly} />
			<WindowRow label={t('budget.usage.thisMonth')} status={status.monthly} />
		</div>
	);
}

/** A NULL adapter config (manual entries, historical rows) groups under one label. */
const UNATTRIBUTED_KEY = 'unattributed';

/** These two spend their stack on the breakdown they exist for, so each cell is the day's total. */
function toAgentCells(points: AgentDailyUsagePoint[] | undefined): SeriesCell[] {
	return (points ?? []).map((p) => ({
		bucket: p.day,
		seriesKey: p.agent_id,
		seriesLabel: agentDisplayName({ human_name: p.agent_name, title: p.agent_title }),
		value: p.total_tokens,
	}));
}

function toAdapterCells(
	points: AdapterDailyUsagePoint[] | undefined,
	unattributed: string,
): SeriesCell[] {
	return (points ?? []).map((p) => ({
		bucket: p.day,
		seriesKey: p.ai_provider_config_id ?? UNATTRIBUTED_KEY,
		seriesLabel: p.adapter_label ?? p.provider ?? unattributed,
		value: p.total_tokens,
	}));
}

function BudgetPage() {
	const { t, formatCompact } = useI18n();
	const { projectId } = Route.useParams();
	const { data: status } = useBudgetStatus(projectId);
	const { data: agentSeries, isLoading: agentLoading } = useAgentDailyUsageSeries(projectId);
	const { data: adapterSeries, isLoading: adapterLoading } = useAdapterDailyUsageSeries(projectId);
	// Per-agent run time, folded into the cards below rather than given a panel of
	// its own. It answers "how long was this agent working", which sits naturally
	// beside its tokens - while "hours" on its own tab means container uptime, the
	// figure that is actually billed. One word, one meaning per surface.
	const { data: hours } = useAgentHours(projectId, HoursBucket.Month);
	const monthSecondsByAgent = new Map(
		(hours?.agents ?? []).map((a) => [a.agent_id, a.month_seconds]),
	);

	return (
		<div className="flex flex-col gap-8">
			{/* Hero + per-window caps + binding-window banner. */}
			<ProjectBudgetPanel projectId={projectId} variant="spend" />

			{/* The subscriptions' weeks gate agent work alongside these budgets. */}
			<SubscriptionUsagePanel />

			<section>
				<SectionHeader
					icon={BarChart3}
					title={t('budget.page.overTime.title')}
					description={t('budget.page.overTime.description')}
				/>
				<div className="flex flex-col gap-4">
					<BudgetCharts projectId={projectId} title={t('budget.page.chart.project')} />
					<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
						<StackedSeriesChart
							title={t('budget.page.chart.byAgent')}
							cells={toAgentCells(agentSeries?.summary)}
							isLoading={agentLoading}
							toDisplay={(tokens) => tokens}
							formatValue={formatCompact}
							formatBucket={formatDay}
							emptyText={t('budget.usage.chart.empty')}
							testId="stacked-usage-chart"
						/>
						<StackedSeriesChart
							title={t('budget.page.chart.byAdapter')}
							cells={toAdapterCells(adapterSeries?.summary, t('budget.page.unattributed'))}
							isLoading={adapterLoading}
							toDisplay={(tokens) => tokens}
							formatValue={formatCompact}
							formatBucket={formatDay}
							emptyText={t('budget.usage.chart.empty')}
							testId="stacked-usage-chart"
						/>
					</div>
				</div>
			</section>

			{status && (
				<section>
					<SectionHeader
						icon={Users}
						title={t('budget.page.agents.title')}
						description={t('budget.page.agents.description')}
					/>
					{status.agents.length === 0 ? (
						<div className="rounded-lg border border-border bg-surface p-4 shadow-xs">
							<p className="text-[13px] text-text-3">{t('budget.page.agents.empty')}</p>
						</div>
					) : (
						<div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
							{status.agents.map((agent) => (
								<div
									key={agent.agent_id}
									data-testid={`agent-budget-row-${agent.agent_slug}`}
									className={`flex flex-col gap-3 rounded-lg border bg-surface p-4 shadow-xs ${
										agent.agent_over_budget ? 'border-danger/40' : 'border-border'
									}`}
								>
									<div className="flex items-center justify-between gap-2">
										<div className="flex min-w-0 items-center gap-2.5">
											<Avatar
												initials={getInitials(agentLabel(agent))}
												imageUrl={agentAvatarUrl({
													slug: agent.agent_slug,
													avatar_spec: agent.agent_avatar_spec,
												})}
												size="sm"
												running={agent.runtime_status === 'running'}
											/>
											<AgentRef
												agent={{
													human_name: agent.agent_name,
													title: agent.agent_title,
													slug: agent.agent_slug,
												}}
												className="truncate text-[13px] font-medium text-text-1"
											/>
										</div>
										<div className="flex shrink-0 items-center gap-2">
											{agent.agent_over_budget && (
												<Badge color="danger">{t('budget.page.agents.overBudget')}</Badge>
											)}
											<Link
												to="/projects/$projectId/agents/$agentId/settings"
												params={agentPageParams(projectId, agent.agent_slug)}
												hash="budget"
												aria-label={t('budget.page.agents.editFor', { agent: agentLabel(agent) })}
												title={t('budget.page.agents.edit')}
												data-testid={`edit-agent-budget-${agent.agent_slug}`}
												className="rounded-sm p-1 text-text-3 transition-colors hover:bg-surface-3 hover:text-text-1"
											>
												<Pencil className="h-3.5 w-3.5" aria-hidden />
											</Link>
										</div>
									</div>
									<WindowGrid status={agent} />
									{(monthSecondsByAgent.get(agent.agent_id) ?? 0) > 0 && (
										<span
											className="text-[11.5px] text-text-3"
											data-testid={`agent-run-time-${agent.agent_slug}`}
										>
											{t('budget.agentRunTime', {
												duration: formatDuration(monthSecondsByAgent.get(agent.agent_id) ?? 0),
											})}
										</span>
									)}
								</div>
							))}
						</div>
					)}
				</section>
			)}
		</div>
	);
}

/** What a budget row's agent is called: its own name when set, else its role. */
function agentLabel(agent: { agent_name: string | null; agent_title: string }): string {
	return agentDisplayName({ human_name: agent.agent_name, title: agent.agent_title });
}

export const Route = createFileRoute('/projects/$projectId/budget/')({
	component: BudgetPage,
});
