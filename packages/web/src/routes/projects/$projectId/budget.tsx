import { type BudgetWindowsCents, centsToDollars, HQ_PROJECT_SLUG } from '@hezo/shared';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { BudgetCharts } from '../../../components/budget/budget-charts';
import { BudgetWindowsEditor } from '../../../components/budget/budget-windows-editor';
import { BudgetBar } from '../../../components/ui/budget-bar';
import { Button } from '../../../components/ui/button';
import {
	type EntityBudgetStatus,
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

function BudgetPage() {
	const { projectId } = Route.useParams();
	const { data: status } = useBudgetStatus(projectId);
	// `null` scopes the chart to the whole project; an agent id scopes it to that agent.
	const [chartAgentId, setChartAgentId] = useState<string | null>(null);

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
				<div className="mb-3 flex items-center justify-between gap-2">
					<h2 className="text-sm font-medium text-text-muted">
						Spend over time
						{chartAgentId &&
							status &&
							(() => {
								const a = status.agents.find((x) => x.agent_id === chartAgentId);
								return a ? ` — ${a.agent_title}` : '';
							})()}
					</h2>
					{chartAgentId && (
						<Button variant="ghost" size="sm" onClick={() => setChartAgentId(null)}>
							Show project
						</Button>
					)}
				</div>
				<BudgetCharts projectId={projectId} agentId={chartAgentId ?? undefined} />
			</section>

			{status && (
				<section>
					<h2 className="mb-3 text-sm font-medium text-text-muted">Agent budgets</h2>
					{status.agents.length === 0 ? (
						<p className="text-[13px] text-text-subtle">No agents yet.</p>
					) : (
						<div className="flex flex-col gap-2">
							{status.agents.map((agent) => (
								<button
									type="button"
									key={agent.agent_id}
									onClick={() => setChartAgentId(agent.agent_id)}
									data-testid={`agent-budget-row-${agent.agent_slug}`}
									className={`flex flex-col gap-3 rounded-radius-md border bg-bg p-4 text-left transition-colors hover:border-border-hover ${
										chartAgentId === agent.agent_id ? 'border-accent-blue' : 'border-border'
									}`}
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
								</button>
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
