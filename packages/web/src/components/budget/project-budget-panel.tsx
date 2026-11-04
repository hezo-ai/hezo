import type { BudgetWindowsTokens } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { Clock, Loader2, Pencil } from 'lucide-react';
import { type Ref, useState } from 'react';
import { useProject, useUpdateProject } from '../../hooks/use-projects';
import { type EntityBudgetStatus, useBudgetStatus, type WindowStatus } from '../../hooks/use-usage';
import { type MessageKey, useI18n } from '../../lib/i18n';
import { Button } from '../ui/button';
import { SectionHeader } from '../ui/section-header';
import {
	BindingBanner,
	useResetCaption,
	WINDOW_KEYS,
	WindowColumn,
	type WindowFigures,
	type WindowKey,
} from './budget-window-figures';
import { BudgetWindowsEditor } from './budget-windows-editor';

const WINDOW_LABELS: Record<WindowKey, MessageKey> = {
	daily: 'budget.usage.today',
	weekly: 'budget.usage.thisWeek',
	monthly: 'budget.usage.thisMonth',
};

/** A token window as the shared figures read it. */
function tokenFigures(s: WindowStatus): WindowFigures {
	return { used: s.usedTokens, limit: s.limitTokens, over: s.overBudget };
}

/** The token windows, keyed as the shared figures read them. */
function tokenWindows(project: EntityBudgetStatus): Record<WindowKey, WindowFigures> {
	return {
		daily: tokenFigures(project.daily),
		weekly: tokenFigures(project.weekly),
		monthly: tokenFigures(project.monthly),
	};
}

/** The token month is the UTC calendar month, so it ends on the first of the next. */
function calendarMonthEnd(): Date {
	const now = new Date();
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
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

function TokenBindingBanner({
	project,
	projectId,
}: {
	project: EntityBudgetStatus;
	projectId: string;
}) {
	const { t, formatCompact } = useI18n();
	return (
		<BindingBanner
			windows={tokenWindows(project)}
			labels={WINDOW_LABELS}
			body={(percent, limit, remaining) =>
				t('budget.usage.binding.body', {
					percent,
					limit: formatCompact(limit),
					remaining: formatCompact(remaining),
				})
			}
			action={
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
			}
		/>
	);
}

/** The three token windows as columns, each with its reset caption. */
function TokenWindowColumns({ project }: { project: EntityBudgetStatus }) {
	const { t, formatCompact } = useI18n();
	const resetCaption = useResetCaption();
	const windows = tokenWindows(project);
	const monthEnd = calendarMonthEnd();
	return (
		<>
			{WINDOW_KEYS.map((key) => (
				<WindowColumn
					key={key}
					figures={windows[key]}
					label={t(WINDOW_LABELS[key])}
					format={formatCompact}
					resetCaption={resetCaption(key, monthEnd)}
					testId={`budget-window-${key}`}
				/>
			))}
		</>
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
 * The project's token budget windows in one place. `variant="spend"` (Tokens tab)
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
						// The Tokens tab is read-only for caps; editing lives in project
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
								<TokenWindowColumns project={status.project} />
							</div>
						</div>
						<TokenBindingBanner project={status.project} projectId={projectId} />
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
