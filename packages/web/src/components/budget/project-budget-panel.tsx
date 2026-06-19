import { type BudgetWindowsCents, centsToDollars } from '@hezo/shared';
import { Clock, Loader2, Pencil, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import {
	type EntityBudgetStatus,
	useBudgetStatus,
	useDailyCostSeries,
	type WindowStatus,
} from '../../hooks/use-costs';
import { useProject, useUpdateProject } from '../../hooks/use-projects';
import { Button } from '../ui/button';
import { SectionHeader } from '../ui/section-header';
import { BudgetWindowsEditor } from './budget-windows-editor';

function dollars(cents: number): string {
	return `$${centsToDollars(cents)}`;
}

type WindowKey = 'daily' | 'weekly' | 'monthly';
const WINDOW_LABELS: Record<WindowKey, string> = {
	daily: 'Today',
	weekly: 'This week',
	monthly: 'This month',
};

function pctUsed(s: WindowStatus): number {
	if (s.limitCents <= 0) return 0;
	return Math.min(Math.round((s.spentCents / s.limitCents) * 100), 999);
}

function toneFor(s: WindowStatus): 'success' | 'warning' | 'danger' {
	const p = pctUsed(s);
	if (s.overBudget || p >= 90) return 'danger';
	if (p >= 70) return 'warning';
	return 'success';
}

const TONE_TEXT = {
	success: 'text-success',
	warning: 'text-warning',
	danger: 'text-danger',
} as const;
const TONE_BAR = { success: 'bg-success', warning: 'bg-warning', danger: 'bg-danger' } as const;

/** Each window resets on a UTC boundary; compute the caption client-side. */
function resetCaption(w: WindowKey): string {
	const now = new Date();
	if (w === 'daily') {
		const reset = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
		const ms = reset - now.getTime();
		const h = Math.floor(ms / 3_600_000);
		const m = Math.floor((ms % 3_600_000) / 60_000);
		return `resets in ${h}h ${String(m).padStart(2, '0')}m`;
	}
	if (w === 'weekly') return 'resets Mon';
	const nm = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
	return `resets ${nm.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} 1`;
}

function WindowColumn({
	status,
	windowKey,
	onEdit,
}: {
	status: WindowStatus;
	windowKey: WindowKey;
	onEdit: () => void;
}) {
	const unlimited = status.limitCents <= 0;
	const tone = toneFor(status);
	const p = pctUsed(status);
	return (
		<div className="flex flex-1 flex-col gap-2 p-5" data-testid={`budget-window-${windowKey}`}>
			<div className="flex items-center justify-between">
				<span className="text-eyebrow text-text-3">{WINDOW_LABELS[windowKey]}</span>
				{!unlimited && (
					<span className={`font-mono text-[12px] font-medium ${TONE_TEXT[tone]}`}>{p}%</span>
				)}
			</div>
			<div className="flex items-center gap-1.5">
				<span className="font-mono text-[18px] font-semibold tabular-nums text-text-1">
					{dollars(status.spentCents)}
				</span>
				<span className="font-mono text-[13px] text-text-3">
					/ {unlimited ? 'no cap' : dollars(status.limitCents)}
				</span>
				<button
					type="button"
					onClick={onEdit}
					aria-label={`Edit ${WINDOW_LABELS[windowKey]} cap`}
					className="ml-0.5 text-text-3 transition-colors hover:text-text-1"
				>
					<Pencil className="h-3 w-3" />
				</button>
			</div>
			{!unlimited && (
				<div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
					<div
						className={`h-full rounded-full ${TONE_BAR[tone]}`}
						style={{ width: `${Math.min(p, 100)}%` }}
					/>
				</div>
			)}
			<span className="text-[11px] text-text-3">
				{unlimited ? 'unlimited' : resetCaption(windowKey)}
			</span>
		</div>
	);
}

/** Month-to-date sparkline of daily project spend; days over the daily cap go red. */
function Sparkline({ projectId, dailyCap }: { projectId: string; dailyCap: number }) {
	const { data } = useDailyCostSeries(projectId);
	const month = new Date().toISOString().slice(0, 7);
	const points = (data?.summary ?? []).filter((d) => d.day.startsWith(month));
	if (points.length === 0) return <div className="h-10" aria-hidden />;
	const max = Math.max(...points.map((p) => p.total_cents), 1);
	return (
		<div className="flex h-10 items-end gap-[3px]" aria-hidden>
			{points.map((p) => {
				const over = dailyCap > 0 && p.total_cents >= dailyCap;
				const h = Math.max(Math.round((p.total_cents / max) * 100), 5);
				return (
					<div
						key={p.day}
						className={`flex-1 rounded-sm ${over ? 'bg-danger' : 'bg-surface-3'}`}
						style={{ height: `${h}%` }}
						title={`${p.day}: ${dollars(p.total_cents)}`}
					/>
				);
			})}
		</div>
	);
}

function Hero({
	projectId,
	monthly,
	runsThisMonth,
	dailyCap,
}: {
	projectId: string;
	monthly: WindowStatus;
	runsThisMonth: number;
	dailyCap: number;
}) {
	const now = new Date();
	const monthLong = now.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
	const monthShort = now.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
	const dayOfMonth = now.getUTCDate();
	const daysInMonth = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
	).getUTCDate();
	const spent = monthly.spentCents;
	const projected = dayOfMonth > 0 ? Math.round((spent / dayOfMonth) * daysInMonth) : spent;
	const avg = runsThisMonth > 0 ? spent / runsThisMonth : 0;
	return (
		<div className="flex flex-col gap-3 p-5 lg:w-[300px]">
			<span className="text-eyebrow text-text-3">This month · to date</span>
			<div className="flex items-baseline gap-2">
				<span
					className="font-mono text-[40px] font-semibold leading-none tracking-[-0.03em] tabular-nums text-text-1"
					data-testid="budget-month-spend"
				>
					{dollars(spent)}
				</span>
				<span className="text-[13px] text-text-3">of {monthLong}</span>
			</div>
			<span className="text-[12px] text-text-3">
				{runsThisMonth} {runsThisMonth === 1 ? 'run' : 'runs'} · ≈ {dollars(Math.round(avg))} / run
			</span>
			<Sparkline projectId={projectId} dailyCap={dailyCap} />
			<span className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-1 text-[11px] text-text-2">
				<span className="h-1.5 w-1.5 rounded-full bg-info" />
				projected ≈ {dollars(projected)} by {monthShort} {daysInMonth}
			</span>
		</div>
	);
}

function BindingBanner({ project, onRaise }: { project: EntityBudgetStatus; onRaise: () => void }) {
	const windows = (
		[
			{ key: 'daily', s: project.daily },
			{ key: 'weekly', s: project.weekly },
			{ key: 'monthly', s: project.monthly },
		] as { key: WindowKey; s: WindowStatus }[]
	).filter((w) => w.s.limitCents > 0);
	if (windows.length === 0) return null;
	const binding = windows.reduce((a, b) => (pctUsed(b.s) > pctUsed(a.s) ? b : a));
	const p = pctUsed(binding.s);
	if (p < 70) return null;
	const over = binding.s.overBudget || p >= 100;
	const remaining = Math.max(binding.s.limitCents - binding.s.spentCents, 0);
	const scope =
		binding.key === 'daily' ? 'today' : binding.key === 'weekly' ? 'this week' : 'this month';
	const fg = over ? 'text-danger-soft-fg' : 'text-warning-soft-fg';
	return (
		<div
			data-testid="binding-window-banner"
			className={`mt-4 flex flex-col gap-2 rounded-md border px-4 py-3 sm:flex-row sm:items-center sm:justify-between ${
				over ? 'border-danger/30 bg-danger-soft' : 'border-warning/30 bg-warning-soft'
			}`}
		>
			<div className="flex items-start gap-2 text-[13px]">
				<TriangleAlert className={`mt-0.5 h-4 w-4 shrink-0 ${fg}`} aria-hidden />
				<p className={fg}>
					<strong className="font-semibold">
						{WINDOW_LABELS[binding.key]} is the binding window
					</strong>{' '}
					— at {p}% of the {dollars(binding.s.limitCents)} {binding.key} cap. Runs pause at the cap;
					about {dollars(remaining)} left {scope}.
				</p>
			</div>
			<Button variant="secondary" size="sm" onClick={onRaise} className="shrink-0">
				Raise {binding.key} cap
			</Button>
		</div>
	);
}

/** A compact "label: value" cap cell for the settings (no-spend) variant. */
function LimitCell({ label, cents }: { label: string; cents: number }) {
	return (
		<div className="flex flex-col gap-1">
			<span className="text-eyebrow text-text-3">{label}</span>
			<span className="font-mono text-[15px] text-text-1">
				{cents === 0 ? 'No cap' : dollars(cents)}
			</span>
		</div>
	);
}

/**
 * The project's budget windows in one place. `variant="spend"` (Budget page)
 * renders the Wire hero + per-window columns + binding-window banner;
 * `variant="limits"` (Project settings) shows a compact read-only cap view.
 * Both share one editor + save path (cross-window rules live in one place).
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
			? 'Spend across every agent in this project. Runs pause when a window cap is reached — the one place Hezo gates on cost.'
			: 'Spend across all agents in this project. A run is blocked when any window is exceeded. Disable a window to leave it uncapped.';

	return (
		<section>
			<SectionHeader
				icon={Clock}
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
							Edit caps
						</Button>
					)
				}
			/>

			{editing ? (
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
					<>
						<div className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface shadow-xs lg:flex-row lg:divide-x lg:divide-y-0">
							<Hero
								projectId={projectId}
								monthly={status.project.monthly}
								runsThisMonth={status.runsThisMonth}
								dailyCap={project.daily_budget_cents}
							/>
							<div className="flex flex-1 flex-col divide-y divide-border sm:flex-row sm:divide-x sm:divide-y-0">
								<WindowColumn
									windowKey="daily"
									status={status.project.daily}
									onEdit={startEditing}
								/>
								<WindowColumn
									windowKey="weekly"
									status={status.project.weekly}
									onEdit={startEditing}
								/>
								<WindowColumn
									windowKey="monthly"
									status={status.project.monthly}
									onEdit={startEditing}
								/>
							</div>
						</div>
						<BindingBanner project={status.project} onRaise={startEditing} />
					</>
				) : (
					<div className="h-[180px] animate-pulse rounded-lg border border-border bg-surface-2" />
				)
			) : (
				<div className="rounded-lg border border-border bg-surface p-4 shadow-xs">
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
