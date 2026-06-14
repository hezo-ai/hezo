import { type BudgetWindowsCents, centsToDollars, HQ_PROJECT_SLUG } from '@hezo/shared';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { BarChart3, Gauge, Loader2, type LucideIcon, Pencil, Users, Wallet } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { BudgetCharts } from '../../../components/budget/budget-charts';
import { BudgetWindowsEditor } from '../../../components/budget/budget-windows-editor';
import { type SpendCell, StackedSpendChart } from '../../../components/budget/stacked-spend-chart';
import { Badge } from '../../../components/ui/badge';
import { BudgetBar } from '../../../components/ui/budget-bar';
import { Button } from '../../../components/ui/button';
import {
	type AdapterDailyCostPoint,
	type AgentDailyCostPoint,
	type EntityBudgetStatus,
	useAdapterDailyCostSeries,
	useAgentDailyCostSeries,
	useBudgetStatus,
	type WindowStatus,
} from '../../../hooks/use-costs';
import { useProject, useUpdateProject } from '../../../hooks/use-projects';

function dollars(cents: number): string {
	return `$${centsToDollars(cents)}`;
}

/** Section heading with a leading icon and an optional right-aligned action. */
function SectionHeader({
	icon: Icon,
	title,
	description,
	action,
}: {
	icon: LucideIcon;
	title: string;
	description?: string;
	action?: ReactNode;
}) {
	return (
		<div className="mb-3 flex items-start justify-between gap-3">
			<div className="flex items-start gap-2">
				<Icon className="mt-0.5 h-4 w-4 shrink-0 text-text-subtle" aria-hidden />
				<div>
					<h2 className="text-sm font-medium text-text">{title}</h2>
					{description && (
						<p className="mt-1 max-w-prose text-xs leading-relaxed text-text-subtle">
							{description}
						</p>
					)}
				</div>
			</div>
			{action && <div className="shrink-0">{action}</div>}
		</div>
	);
}

/** A prominent per-window KPI: big spend figure, limit, and a fill bar. */
function WindowStatCard({ label, status }: { label: string; status: WindowStatus }) {
	const unlimited = status.limitCents === 0;
	const pct = unlimited
		? 0
		: Math.min(Math.round((status.spentCents / status.limitCents) * 100), 100);
	return (
		<div
			className={`flex flex-col gap-3 rounded-radius-md border bg-bg p-4 ${
				status.overBudget ? 'border-accent-red/40 bg-accent-red/5' : 'border-border'
			}`}
		>
			<div className="flex items-center justify-between gap-2">
				<span className="text-xs font-medium uppercase tracking-wider text-text-subtle">
					{label}
				</span>
				{status.overBudget && <Badge color="red">Over budget</Badge>}
			</div>
			<div className="flex items-baseline gap-1.5">
				<span
					className={`font-mono text-2xl font-semibold tabular-nums ${
						status.overBudget ? 'text-accent-red' : 'text-text'
					}`}
				>
					{dollars(status.spentCents)}
				</span>
				<span className="text-[13px] text-text-subtle">
					/ {unlimited ? '∞' : dollars(status.limitCents)}
				</span>
			</div>
			{unlimited ? (
				<span className="text-xs text-text-subtle">No limit set</span>
			) : (
				<div className="flex flex-col gap-1.5">
					<BudgetBar used={status.spentCents} total={status.limitCents} />
					<span className="text-xs text-text-subtle">{pct}% of limit used</span>
				</div>
			)}
		</div>
	);
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

function ProjectBudgetForm({ projectId }: { projectId: string }) {
	const { data: project } = useProject(projectId);
	const updateProject = useUpdateProject(projectId);
	const [editing, setEditing] = useState(false);
	const [budget, setBudget] = useState<BudgetWindowsCents>({
		daily_budget_cents: 0,
		weekly_budget_cents: 0,
		monthly_budget_cents: 0,
	});

	if (!project) return null;

	function startEditing() {
		if (!project) return;
		setBudget({
			daily_budget_cents: project.daily_budget_cents,
			weekly_budget_cents: project.weekly_budget_cents,
			monthly_budget_cents: project.monthly_budget_cents,
		});
		setEditing(true);
	}

	async function handleSave(e: React.FormEvent) {
		e.preventDefault();
		await updateProject.mutateAsync(budget);
		setEditing(false);
	}

	const limits: { label: string; cents: number }[] = [
		{ label: 'Daily', cents: project.daily_budget_cents },
		{ label: 'Weekly', cents: project.weekly_budget_cents },
		{ label: 'Monthly', cents: project.monthly_budget_cents },
	];

	return (
		<section>
			<SectionHeader
				icon={Wallet}
				title="Project budget limits"
				description="Spend across all agents in this project. A run is blocked when the project exceeds any window. Disable a window to leave it unlimited."
				action={
					!editing && (
						<Button variant="ghost" size="sm" onClick={startEditing}>
							<Pencil className="h-3.5 w-3.5" aria-hidden />
							Edit
						</Button>
					)
				}
			/>
			<div className="rounded-radius-md border border-border bg-bg p-4">
				{editing ? (
					<form onSubmit={handleSave} className="flex flex-col gap-4">
						<BudgetWindowsEditor value={budget} onChange={setBudget} />
						<div className="flex gap-2">
							<Button type="submit" size="sm" disabled={updateProject.isPending}>
								{updateProject.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Save'}
							</Button>
							<Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
								Cancel
							</Button>
						</div>
					</form>
				) : (
					<div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
						{limits.map((l) => (
							<div key={l.label} className="flex flex-col gap-1">
								<span className="text-xs font-medium uppercase tracking-wider text-text-subtle">
									{l.label}
								</span>
								<span className="font-mono text-[15px] text-text">
									{l.cents === 0 ? 'Unlimited' : dollars(l.cents)}
								</span>
							</div>
						))}
					</div>
				)}
			</div>
		</section>
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

			{status && (
				<section>
					<SectionHeader
						icon={Gauge}
						title="Project spend"
						description="Current spend across all agents in each rolling window."
					/>
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
						<WindowStatCard label="Daily" status={status.project.daily} />
						<WindowStatCard label="Weekly" status={status.project.weekly} />
						<WindowStatCard label="Monthly" status={status.project.monthly} />
					</div>
				</section>
			)}

			<ProjectBudgetForm projectId={projectId} />

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
