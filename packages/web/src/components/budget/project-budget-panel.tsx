import type { BudgetWindowsTokens } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { Clock, Loader2, Pencil, TriangleAlert } from 'lucide-react';
import { type Ref, useState } from 'react';
import { useProject, useUpdateProject } from '../../hooks/use-projects';
import { type EntityBudgetStatus, useBudgetStatus, type WindowStatus } from '../../hooks/use-usage';
import { type MessageKey, useI18n } from '../../lib/i18n';
import { Button } from '../ui/button';
import { SectionHeader } from '../ui/section-header';
import { BudgetWindowsEditor } from './budget-windows-editor';

type WindowKey = 'daily' | 'weekly' | 'monthly';
const WINDOW_LABELS: Record<WindowKey, MessageKey> = {
	daily: 'budget.usage.today',
	weekly: 'budget.usage.thisWeek',
	monthly: 'budget.usage.thisMonth',
};

function pctUsed(s: WindowStatus): number {
	if (s.limitTokens <= 0) return 0;
	return Math.min(Math.round((s.usedTokens / s.limitTokens) * 100), 999);
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

/** Each window resets on a UTC boundary; the caption is computed client-side. */
function useResetCaption(): (w: WindowKey) => string {
	const { t, formatDate } = useI18n();
	return (w) => {
		const now = new Date();
		if (w === 'daily') {
			const reset = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
			const ms = reset - now.getTime();
			return t('budget.usage.resetsIn', {
				hours: Math.floor(ms / 3_600_000),
				minutes: String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, '0'),
			});
		}
		if (w === 'weekly') return t('budget.usage.resetsMonday');
		const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
		return t('budget.usage.resetsOn', { date: formatDate(next) });
	};
}

function WindowColumn({ status, windowKey }: { status: WindowStatus; windowKey: WindowKey }) {
	const { t, formatCompact } = useI18n();
	const resetCaption = useResetCaption();
	const unlimited = status.limitTokens <= 0;
	const tone = toneFor(status);
	const p = pctUsed(status);
	return (
		<div className="flex flex-1 flex-col gap-2 p-5" data-testid={`budget-window-${windowKey}`}>
			<div className="flex items-center justify-between">
				<span className="text-eyebrow text-text-3">{t(WINDOW_LABELS[windowKey])}</span>
				{!unlimited && (
					<span className={`font-mono text-[12px] font-medium ${TONE_TEXT[tone]}`}>{p}%</span>
				)}
			</div>
			<div className="flex items-center gap-1.5">
				<span className="font-mono text-[18px] font-semibold tabular-nums text-text-1">
					{formatCompact(status.usedTokens)}
				</span>
				<span className="font-mono text-[13px] text-text-3">
					/ {unlimited ? t('budget.usage.noLimit') : formatCompact(status.limitTokens)}
				</span>
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
				{unlimited ? t('budget.usage.unlimited') : resetCaption(windowKey)}
			</span>
		</div>
	);
}

function Hero({ monthly, runsThisMonth }: { monthly: WindowStatus; runsThisMonth: number }) {
	const { t, plural, formatCompact, formatDate } = useI18n();
	const now = new Date();
	const monthLong = new Intl.DateTimeFormat(undefined, { month: 'long', timeZone: 'UTC' }).format(
		now,
	);
	const dayOfMonth = now.getUTCDate();
	const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
	const daysInMonth = monthEnd.getUTCDate();
	const used = monthly.usedTokens;
	const projected = dayOfMonth > 0 ? Math.round((used / dayOfMonth) * daysInMonth) : used;
	const avg = runsThisMonth > 0 ? used / runsThisMonth : 0;
	return (
		<div className="flex flex-col gap-3 p-5 lg:w-[300px]">
			<span className="text-eyebrow text-text-3">{t('budget.usage.monthToDate')}</span>
			<div className="flex items-baseline gap-2">
				<span
					className="font-mono text-[40px] font-semibold leading-none tracking-[-0.03em] tabular-nums text-text-1"
					data-testid="budget-month-usage"
				>
					{formatCompact(used)}
				</span>
				<span className="text-[13px] text-text-3">
					{t('budget.usage.tokensOfMonth', { month: monthLong })}
				</span>
			</div>
			<span className="text-[12px] text-text-3">
				{plural('budget.usage.runs', runsThisMonth, {
					count: runsThisMonth,
					avg: formatCompact(Math.round(avg)),
				})}
			</span>
			<span className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-1 text-[11px] text-text-2">
				<span className="h-1.5 w-1.5 rounded-full bg-info" />
				{t('budget.usage.projected', {
					amount: formatCompact(projected),
					date: formatDate(monthEnd),
				})}
			</span>
		</div>
	);
}

function BindingBanner({ project, projectId }: { project: EntityBudgetStatus; projectId: string }) {
	const { t, formatCompact } = useI18n();
	const windows = (
		[
			{ key: 'daily', s: project.daily },
			{ key: 'weekly', s: project.weekly },
			{ key: 'monthly', s: project.monthly },
		] as { key: WindowKey; s: WindowStatus }[]
	).filter((w) => w.s.limitTokens > 0);
	if (windows.length === 0) return null;
	const binding = windows.reduce((a, b) => (pctUsed(b.s) > pctUsed(a.s) ? b : a));
	const p = pctUsed(binding.s);
	if (p < 70) return null;
	const over = binding.s.overBudget || p >= 100;
	const remaining = Math.max(binding.s.limitTokens - binding.s.usedTokens, 0);
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
						{t('budget.usage.binding.title', { window: t(WINDOW_LABELS[binding.key]) })}
					</strong>{' '}
					{t('budget.usage.binding.body', {
						percent: p,
						limit: formatCompact(binding.s.limitTokens),
						remaining: formatCompact(remaining),
					})}
				</p>
			</div>
			<Link
				to="/projects/$projectId/settings"
				params={{ projectId }}
				hash="budget"
				className="shrink-0"
			>
				<Button variant="secondary" size="sm" className="w-full sm:w-auto">
					{t('budget.usage.binding.raise')}
				</Button>
			</Link>
		</div>
	);
}

/** A compact "label: value" limit cell for the settings (no-usage) variant. */
function LimitCell({ label, tokens }: { label: string; tokens: number }) {
	const { t, formatNumber } = useI18n();
	return (
		<div className="flex flex-col gap-1">
			<span className="text-eyebrow text-text-3">{label}</span>
			<span className="font-mono text-[15px] text-text-1">
				{tokens === 0
					? t('budget.usage.noLimit')
					: t('usage.figure.short', { count: formatNumber(tokens) })}
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
	sectionRef,
	sectionId,
}: {
	projectId: string;
	variant?: 'spend' | 'limits';
	/** Anchor hooks so a deep link (`…/settings#budget`) can scroll to this section. */
	sectionRef?: Ref<HTMLElement>;
	sectionId?: string;
}) {
	const { t } = useI18n();
	const { data: project } = useProject(projectId);
	const { data: status } = useBudgetStatus(projectId, { enabled: variant === 'spend' });
	const updateProject = useUpdateProject(projectId);
	const [editing, setEditing] = useState(false);
	const [budget, setBudget] = useState<BudgetWindowsTokens>({
		daily_budget_tokens: 0,
		weekly_budget_tokens: 0,
		monthly_budget_tokens: 0,
	});

	if (!project) return null;

	function startEditing() {
		if (!project) return;
		setBudget({
			daily_budget_tokens: project.daily_budget_tokens,
			weekly_budget_tokens: project.weekly_budget_tokens,
			monthly_budget_tokens: project.monthly_budget_tokens,
		});
		setEditing(true);
	}

	async function save() {
		await updateProject.mutateAsync(budget);
		setEditing(false);
	}

	return (
		<section ref={sectionRef} id={sectionId} className={sectionId ? 'scroll-mt-20' : undefined}>
			<SectionHeader
				icon={Clock}
				title={t('budget.panel.title')}
				action={
					variant === 'spend' ? (
						// The Budget page is read-only for caps; editing lives in project
						// settings. This single header button takes you straight there.
						<Link to="/projects/$projectId/settings" params={{ projectId }} hash="budget">
							<Button variant="ghost" size="sm" data-testid="edit-project-budget-link">
								<Pencil className="h-3.5 w-3.5" aria-hidden />
								{t('common.edit')}
							</Button>
						</Link>
					) : (
						!editing && (
							<Button
								variant="ghost"
								size="sm"
								onClick={startEditing}
								data-testid="edit-project-budget"
							>
								<Pencil className="h-3.5 w-3.5" aria-hidden />
								{t('budget.panel.editLimits')}
							</Button>
						)
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
							{updateProject.isPending ? (
								<Loader2 className="h-3 w-3 animate-spin" />
							) : (
								t('common.save')
							)}
						</Button>
						<Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
							{t('common.cancel')}
						</Button>
					</div>
				</form>
			) : variant === 'spend' ? (
				status ? (
					<>
						<div className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface shadow-xs lg:flex-row lg:divide-x lg:divide-y-0">
							<Hero monthly={status.project.monthly} runsThisMonth={status.runsThisMonth} />
							<div className="flex flex-1 flex-col divide-y divide-border sm:flex-row sm:divide-x sm:divide-y-0">
								<WindowColumn windowKey="daily" status={status.project.daily} />
								<WindowColumn windowKey="weekly" status={status.project.weekly} />
								<WindowColumn windowKey="monthly" status={status.project.monthly} />
							</div>
						</div>
						<BindingBanner project={status.project} projectId={projectId} />
					</>
				) : (
					<div className="h-[180px] animate-pulse rounded-lg border border-border bg-surface-2" />
				)
			) : (
				<div className="rounded-lg border border-border bg-surface p-4 shadow-xs">
					<div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
						<LimitCell label={t('budget.window.daily')} tokens={project.daily_budget_tokens} />
						<LimitCell label={t('budget.window.weekly')} tokens={project.weekly_budget_tokens} />
						<LimitCell label={t('budget.window.monthly')} tokens={project.monthly_budget_tokens} />
					</div>
				</div>
			)}
		</section>
	);
}
