import { type BudgetWindowsCents, centsToDollars } from '@hezo/shared';
import { Gauge, Loader2, Pencil } from 'lucide-react';
import { useState } from 'react';
import { useBudgetStatus, type WindowStatus } from '../../hooks/use-costs';
import { useProject, useUpdateProject } from '../../hooks/use-projects';
import { Badge } from '../ui/badge';
import { BudgetBar } from '../ui/budget-bar';
import { Button } from '../ui/button';
import { SectionHeader } from '../ui/section-header';
import { BudgetWindowsEditor } from './budget-windows-editor';

function dollars(cents: number): string {
	return `$${centsToDollars(cents)}`;
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

/** A compact "label: value" limit cell for the settings (no-spend) variant. */
function LimitCell({ label, cents }: { label: string; cents: number }) {
	return (
		<div className="flex flex-col gap-1">
			<span className="text-xs font-medium uppercase tracking-wider text-text-subtle">{label}</span>
			<span className="font-mono text-[15px] text-text">
				{cents === 0 ? 'Unlimited' : dollars(cents)}
			</span>
		</div>
	);
}

/**
 * The project's budget windows in one place: the spend-vs-limit progress display
 * and the limit editor are the same section, toggled by an Edit button.
 *
 * - `variant="spend"` (Budget page): live per-window KPI cards (spend, limit, fill
 *   bar, % used, over-budget state). Editing swaps the cards for the window editor.
 * - `variant="limits"` (Project settings): a compact read-only view of the limits,
 *   with the same Edit → editor flow. No spend is fetched/shown.
 *
 * Both share one editor + save path so the cross-window rules live in a single place.
 */
export function ProjectBudgetPanel({
	projectId,
	variant = 'spend',
}: {
	projectId: string;
	variant?: 'spend' | 'limits';
}) {
	const { data: project } = useProject(projectId);
	const { data: status } = useBudgetStatus(projectId, { enabled: variant === 'spend' });
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

	async function save() {
		await updateProject.mutateAsync(budget);
		setEditing(false);
	}

	const description =
		variant === 'spend'
			? 'Spend across all agents in this project. A run is blocked when any window is exceeded — edit to change the limits.'
			: 'Spend across all agents in this project. A run is blocked when any window is exceeded. Disable a window to leave it unlimited.';

	return (
		<section>
			<SectionHeader
				icon={Gauge}
				title="Project budget"
				description={description}
				action={
					!editing && (
						<Button
							variant="ghost"
							size="sm"
							onClick={startEditing}
							data-testid="edit-project-budget"
						>
							<Pencil className="h-3.5 w-3.5" aria-hidden />
							Edit limits
						</Button>
					)
				}
			/>

			{editing ? (
				// Enter submits via the form; the buttons drive save/cancel explicitly so
				// the flow doesn't hinge on implicit submit-button behaviour.
				<form
					onSubmit={(e) => {
						e.preventDefault();
						void save();
					}}
					className="flex flex-col gap-4"
				>
					<BudgetWindowsEditor value={budget} onChange={setBudget} />
					<div className="flex gap-2">
						<Button
							type="button"
							size="sm"
							disabled={updateProject.isPending}
							onClick={() => void save()}
						>
							{updateProject.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Save'}
						</Button>
						<Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
							Cancel
						</Button>
					</div>
				</form>
			) : variant === 'spend' ? (
				status ? (
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
						<WindowStatCard label="Daily" status={status.project.daily} />
						<WindowStatCard label="Weekly" status={status.project.weekly} />
						<WindowStatCard label="Monthly" status={status.project.monthly} />
					</div>
				) : (
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
						{['Daily', 'Weekly', 'Monthly'].map((label) => (
							<div
								key={label}
								className="h-[104px] animate-pulse rounded-radius-md border border-border bg-bg-subtle"
							/>
						))}
					</div>
				)
			) : (
				<div className="rounded-radius-md border border-border bg-bg p-4">
					<div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
						<LimitCell label="Daily" cents={project.daily_budget_cents} />
						<LimitCell label="Weekly" cents={project.weekly_budget_cents} />
						<LimitCell label="Monthly" cents={project.monthly_budget_cents} />
					</div>
				</div>
			)}
		</section>
	);
}
