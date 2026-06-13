import { type BudgetWindowsCents, centsToDollars, HQ_PROJECT_SLUG } from '@hezo/shared';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { BudgetCharts } from '../../../components/budget/budget-charts';
import { BudgetWindowsEditor } from '../../../components/budget/budget-windows-editor';
import { type SpendCell, StackedSpendChart } from '../../../components/budget/stacked-spend-chart';
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

	return (
		<section>
			<h2 className="mb-3 text-sm font-medium text-text-muted">Project budget limits</h2>
			<p className="-mt-2 mb-3 text-xs text-text-subtle">
				Spend across all agents in this project. A run is blocked when the project exceeds any
				window. Disable a window to leave it unlimited.
			</p>
			{editing ? (
				<form onSubmit={handleSave} className="flex flex-col gap-3 sm:max-w-xl">
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
				<div className="space-y-1 text-[13px]">
					<div>
						<span className="text-text-muted">Daily:</span>{' '}
						{project.daily_budget_cents === 0 ? 'Unlimited' : dollars(project.daily_budget_cents)}
					</div>
					<div>
						<span className="text-text-muted">Weekly:</span>{' '}
						{project.weekly_budget_cents === 0 ? 'Unlimited' : dollars(project.weekly_budget_cents)}
					</div>
					<div>
						<span className="text-text-muted">Monthly:</span>{' '}
						{project.monthly_budget_cents === 0
							? 'Unlimited'
							: dollars(project.monthly_budget_cents)}
					</div>
					<Button variant="ghost" size="sm" onClick={startEditing} className="mt-2">
						Edit
					</Button>
				</div>
			)}
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
			<ProjectBudgetForm projectId={projectId} />

			{status && (
				<section>
					<h2 className="mb-3 text-sm font-medium text-text-muted">Project spend</h2>
					<div className="rounded-radius-md border border-border bg-bg p-4">
						<WindowGrid status={status.project} />
					</div>
				</section>
			)}

			<section>
				<h2 className="mb-3 text-sm font-medium text-text-muted">Project spend per day</h2>
				<BudgetCharts projectId={projectId} />
			</section>

			<section>
				<h2 className="mb-3 text-sm font-medium text-text-muted">Spend per day by agent</h2>
				<StackedSpendChart cells={toAgentCells(agentSeries?.summary)} isLoading={agentLoading} />
			</section>

			<section>
				<h2 className="mb-3 text-sm font-medium text-text-muted">Spend per day by AI adapter</h2>
				<StackedSpendChart
					cells={toAdapterCells(adapterSeries?.summary)}
					isLoading={adapterLoading}
				/>
			</section>

			{status && (
				<section>
					<h2 className="mb-3 text-sm font-medium text-text-muted">Agent budgets</h2>
					{status.agents.length === 0 ? (
						<p className="text-[13px] text-text-subtle">No agents yet.</p>
					) : (
						<div className="flex flex-col gap-2">
							{status.agents.map((agent) => (
								<div
									key={agent.agent_id}
									data-testid={`agent-budget-row-${agent.agent_slug}`}
									className="flex flex-col gap-3 rounded-radius-md border border-border bg-bg p-4"
								>
									<div className="flex items-center justify-between gap-2">
										<span className="text-[13px] font-medium text-text">{agent.agent_title}</span>
										{agent.agent_over_budget && (
											<span className="rounded-full bg-accent-red/10 px-2 py-0.5 text-[11px] font-medium text-accent-red">
												Over budget
											</span>
										)}
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
