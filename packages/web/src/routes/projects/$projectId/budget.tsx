import { centsToDollars, HQ_PROJECT_SLUG } from '@hezo/shared';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { BarChart3, Users } from 'lucide-react';
import { BudgetCharts } from '../../../components/budget/budget-charts';
import { ProjectBudgetPanel } from '../../../components/budget/project-budget-panel';
import { type SpendCell, StackedSpendChart } from '../../../components/budget/stacked-spend-chart';
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

function dollars(cents: number): string {
	return `$${centsToDollars(cents)}`;
}

/** A single window's spend vs. limit with a fill bar. 0 limit renders "unlimited". */
function WindowRow({ label, status }: { label: string; status: WindowStatus }) {
	const unlimited = status.limitCents === 0;
	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center justify-between text-[13px]">
				<span className="text-text-muted">{label}</span>
				<span className={`font-mono ${status.overBudget ? 'text-accent-red' : 'text-text'}`}>
					{dollars(status.spentCents)}
					{unlimited ? (
						<span className="text-text-subtle"> / ∞</span>
					) : (
						<span className="text-text-subtle"> / {dollars(status.limitCents)}</span>
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
			<WindowRow label="Daily" status={status.daily} />
			<WindowRow label="Weekly" status={status.weekly} />
			<WindowRow label="Monthly" status={status.monthly} />
		</div>
	);
}

/** A NULL adapter config (manual entries, historical rows) groups under one label. */
const UNATTRIBUTED_KEY = 'unattributed';

function toAgentCells(points: AgentDailyCostPoint[] | undefined): SpendCell[] {
	return (points ?? []).map((p) => ({
		day: p.day,
		seriesKey: p.agent_id,
		seriesLabel: p.agent_title,
		total_cents: p.total_cents,
	}));
}

function toAdapterCells(points: AdapterDailyCostPoint[] | undefined): SpendCell[] {
	return (points ?? []).map((p) => ({
		day: p.day,
		seriesKey: p.ai_provider_config_id ?? UNATTRIBUTED_KEY,
		seriesLabel: p.adapter_label ?? p.provider ?? 'Unattributed',
		total_cents: p.total_cents,
	}));
}

function BudgetPage() {
	const { projectId } = Route.useParams();
	const { data: status } = useBudgetStatus(projectId);
	const { data: agentSeries, isLoading: agentLoading } = useAgentDailyCostSeries(projectId);
	const { data: adapterSeries, isLoading: adapterLoading } = useAdapterDailyCostSeries(projectId);

	return (
		<div className="flex flex-col gap-8">
			<div>
				<h1 className="text-base font-semibold text-text">Budget</h1>
				<p className="mt-1 text-xs text-text-subtle">
					Track spend and set limits for this project and its agents.
				</p>
			</div>

			{/* Spend progress + limit editing are one section: the KPI cards show spend vs.
			    limit; Edit swaps them for the window editor. */}
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
						<StackedSpendChart
							title="Spend per day by agent"
							cells={toAgentCells(agentSeries?.summary)}
							isLoading={agentLoading}
						/>
						<StackedSpendChart
							title="Spend per day by AI adapter"
							cells={toAdapterCells(adapterSeries?.summary)}
							isLoading={adapterLoading}
						/>
					</div>
				</div>
			</section>

			{status && (
				<section>
					<SectionHeader
						icon={Users}
						title="Agent budgets"
						description="Each agent's spend against its own per-window limits."
					/>
					{status.agents.length === 0 ? (
						<div className="rounded-radius-md border border-border bg-bg p-4">
							<p className="text-[13px] text-text-subtle">No agents yet.</p>
						</div>
					) : (
						<div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
							{status.agents.map((agent) => (
								<div
									key={agent.agent_id}
									data-testid={`agent-budget-row-${agent.agent_slug}`}
									className={`flex flex-col gap-3 rounded-radius-md border bg-bg p-4 ${
										agent.agent_over_budget ? 'border-accent-red/40' : 'border-border'
									}`}
								>
									<div className="flex items-center justify-between gap-2">
										<div className="flex min-w-0 items-center gap-2">
											<span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-bg-subtle text-[11px] font-medium text-text-muted">
												{agent.agent_title.charAt(0).toUpperCase()}
											</span>
											<span className="truncate text-[13px] font-medium text-text">
												{agent.agent_title}
											</span>
										</div>
										{agent.agent_over_budget && <Badge color="red">Over budget</Badge>}
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

export const Route = createFileRoute('/projects/$projectId/budget')({
	beforeLoad: ({ params }) => {
		// HQ (internal) has no per-project budget surface.
		if (params.projectId === HQ_PROJECT_SLUG) {
			throw redirect({ to: '/projects/$projectId/tasks', params, replace: true });
		}
	},
	component: BudgetPage,
});
