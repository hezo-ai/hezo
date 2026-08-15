import { HQ_PROJECT_SLUG } from '@hezo/shared';
import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { BarChart3, Pencil, Users } from 'lucide-react';
import { agentDisplayName } from '../../../components/agent-identity-tooltip';
import { agentPageParams } from '../../../components/agent-link';
import { AgentRef } from '../../../components/agent-ref';
import { BudgetCharts } from '../../../components/budget/budget-charts';
import { ProjectBudgetPanel } from '../../../components/budget/project-budget-panel';
import { dollars, formatDay } from '../../../components/charts/chart-format';
import {
	type SeriesCell,
	StackedSeriesChart,
} from '../../../components/charts/stacked-series-chart';
import { Avatar, getInitials } from '../../../components/ui/avatar';
import { Badge } from '../../../components/ui/badge';
import { BudgetBar } from '../../../components/ui/budget-bar';
import { SectionHeader } from '../../../components/ui/section-header';
import {
	type AdapterDailyCostPoint,
	type AgentDailyCostPoint,
	type EntityBudgetStatus,
	useAdapterDailyCostSeries,
	useAgentDailyCostSeries,
	useBudgetStatus,
	type WindowStatus,
} from '../../../hooks/use-costs';
import { defaultAvatarForSlug } from '../../../lib/default-avatars';

/** A single window's spend vs. cap with a fill bar. 0 cap renders "no cap". */
function WindowRow({ label, status }: { label: string; status: WindowStatus }) {
	const unlimited = status.limitCents === 0;
	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center justify-between text-[13px]">
				<span className="text-text-2">{label}</span>
				<span className={`font-mono ${status.overBudget ? 'text-danger' : 'text-text-1'}`}>
					{dollars(status.spentCents)}
					{unlimited ? (
						<span className="text-text-3"> / ∞</span>
					) : (
						<span className="text-text-3"> / {dollars(status.limitCents)}</span>
					)}
				</span>
			</div>
			{!unlimited && <BudgetBar used={status.spentCents} total={status.limitCents} />}
		</div>
	);
}

function WindowGrid({ status }: { status: EntityBudgetStatus }) {
	return (
		<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
			<WindowRow label="Today" status={status.daily} />
			<WindowRow label="This week" status={status.weekly} />
			<WindowRow label="This month" status={status.monthly} />
		</div>
	);
}

/** A NULL adapter config (manual entries, historical rows) groups under one label. */
const UNATTRIBUTED_KEY = 'unattributed';

function toAgentCells(points: AgentDailyCostPoint[] | undefined): SeriesCell[] {
	return (points ?? []).map((p) => ({
		bucket: p.day,
		seriesKey: p.agent_id,
		seriesLabel: agentDisplayName({ human_name: p.agent_name, title: p.agent_title }),
		value: p.total_cents,
	}));
}

function toAdapterCells(points: AdapterDailyCostPoint[] | undefined): SeriesCell[] {
	return (points ?? []).map((p) => ({
		bucket: p.day,
		seriesKey: p.ai_provider_config_id ?? UNATTRIBUTED_KEY,
		seriesLabel: p.adapter_label ?? p.provider ?? 'Unattributed',
		value: p.total_cents,
	}));
}

/** Cents are the chart's base unit; dollars are what it plots, and `dollarsSpent`
 *  inverts that exactly for the tooltip. */
const centsToPlottedDollars = (cents: number) => cents / 100;
const dollarsSpent = (plotted: number) => dollars(Math.round(plotted * 100));

function BudgetPage() {
	const { projectId } = Route.useParams();
	const { data: status } = useBudgetStatus(projectId);
	const { data: agentSeries, isLoading: agentLoading } = useAgentDailyCostSeries(projectId);
	const { data: adapterSeries, isLoading: adapterLoading } = useAdapterDailyCostSeries(projectId);

	return (
		<div className="flex flex-col gap-8">
			<div>
				<h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] text-text-1">
					Budget
				</h1>
				<p className="mt-1 text-[13px] text-text-2">
					Track spend and set caps for this project and its agents. Token costs are computed at
					non-cached rates, so figures are a conservative upper-bound estimate.
				</p>
			</div>

			{/* Hero + per-window caps + binding-window banner. */}
			<ProjectBudgetPanel projectId={projectId} variant="spend" />

			<section>
				<SectionHeader
					icon={BarChart3}
					title="Spend over time"
					description="Daily project spend, and the same totals split by agent and by AI adapter."
				/>
				<div className="flex flex-col gap-4">
					<BudgetCharts projectId={projectId} title="Project spend per day" />
					<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
						<StackedSeriesChart
							title="Spend per day by agent"
							cells={toAgentCells(agentSeries?.summary)}
							isLoading={agentLoading}
							toDisplay={centsToPlottedDollars}
							formatValue={dollarsSpent}
							formatBucket={formatDay}
							emptyText="No spend recorded."
							testId="stacked-spend-chart"
						/>
						<StackedSeriesChart
							title="Spend per day by AI adapter"
							cells={toAdapterCells(adapterSeries?.summary)}
							isLoading={adapterLoading}
							toDisplay={centsToPlottedDollars}
							formatValue={dollarsSpent}
							formatBucket={formatDay}
							emptyText="No spend recorded."
							testId="stacked-spend-chart"
						/>
					</div>
				</div>
			</section>

			{status && (
				<section>
					<SectionHeader
						icon={Users}
						title="Agent budgets"
						description="Each agent's spend against its own per-window caps."
					/>
					{status.agents.length === 0 ? (
						<div className="rounded-lg border border-border bg-surface p-4 shadow-xs">
							<p className="text-[13px] text-text-3">No agents yet.</p>
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
												imageUrl={agent.agent_icon_url ?? defaultAvatarForSlug(agent.agent_slug)}
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
											{agent.agent_over_budget && <Badge color="danger">Over budget</Badge>}
											<Link
												to="/projects/$projectId/agents/$agentId/settings"
												params={agentPageParams(projectId, agent.agent_slug)}
												hash="budget"
												aria-label={`Edit ${agentLabel(agent)} budget`}
												title="Edit budget"
												data-testid={`edit-agent-budget-${agent.agent_slug}`}
												className="rounded-sm p-1 text-text-3 transition-colors hover:bg-surface-3 hover:text-text-1"
											>
												<Pencil className="h-3.5 w-3.5" aria-hidden />
											</Link>
										</div>
									</div>
									<WindowGrid status={agent} />
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

export const Route = createFileRoute('/projects/$projectId/budget')({
	beforeLoad: ({ params }) => {
		// HQ (internal) has no per-project budget surface.
		if (params.projectId === HQ_PROJECT_SLUG) {
			throw redirect({ to: '/projects/$projectId/tasks', params, replace: true });
		}
	},
	component: BudgetPage,
});
