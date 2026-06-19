import { centsToDollars, HQ_PROJECT_SLUG } from '@hezo/shared';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { BarChart3, Cpu, Users } from 'lucide-react';
import { useMemo } from 'react';
import { BudgetCharts } from '../../../components/budget/budget-charts';
import { ProjectBudgetPanel } from '../../../components/budget/project-budget-panel';
import { type SpendCell, StackedSpendChart } from '../../../components/budget/stacked-spend-chart';
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

function dollars(cents: number): string {
	return `$${centsToDollars(cents)}`;
}

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

	// Totals per adapter/model across the series — the Wire "Sonnet · $… / Opus · $…" list.
	const adapterTotals = useMemo(() => {
		const map = new Map<string, { label: string; cents: number }>();
		for (const p of adapterSeries?.summary ?? []) {
			const key = p.ai_provider_config_id ?? UNATTRIBUTED_KEY;
			const label = p.adapter_label ?? p.provider ?? 'Unattributed';
			const cur = map.get(key) ?? { label, cents: 0 };
			cur.cents += p.total_cents;
			map.set(key, cur);
		}
		return [...map.values()].sort((a, b) => b.cents - a.cents);
	}, [adapterSeries]);

	return (
		<div className="flex flex-col gap-8">
			<div>
				<h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] text-text-1">
					Budget
				</h1>
				<p className="mt-1 text-[13px] text-text-2">
					Track spend and set caps for this project and its agents.
				</p>
			</div>

			{/* Hero + per-window caps + binding-window banner. */}
			<ProjectBudgetPanel projectId={projectId} variant="spend" />

			{adapterTotals.length > 0 && (
				<section>
					<SectionHeader
						icon={Cpu}
						title="Spend by model"
						description="Total spend grouped by the AI adapter that ran it."
					/>
					<div className="divide-y divide-border rounded-lg border border-border bg-surface shadow-xs">
						{adapterTotals.map((a) => (
							<div
								key={a.label}
								className="flex items-center justify-between px-4 py-2.5 text-[13px]"
							>
								<span className="truncate text-text-2">{a.label}</span>
								<span className="font-mono tabular-nums text-text-1">{dollars(a.cents)}</span>
							</div>
						))}
					</div>
				</section>
			)}

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
												initials={getInitials(agent.agent_title)}
												size="sm"
												running={agent.runtime_status === 'running'}
											/>
											<span className="truncate text-[13px] font-medium text-text-1">
												{agent.agent_title}
											</span>
										</div>
										{agent.agent_over_budget && <Badge color="danger">Over budget</Badge>}
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
