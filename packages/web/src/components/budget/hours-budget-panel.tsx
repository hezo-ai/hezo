import {
	type BudgetWindowsContainerSeconds,
	type ContainerHoursWindowStatus,
	HoursBucket,
	type ProjectContainerHoursBudget,
} from '@hezo/shared';
import { Gauge, Loader2, Pencil } from 'lucide-react';
import { useState } from 'react';
import {
	useInstanceContainerHours,
	useSetProjectContainerHoursBudget,
} from '../../hooks/use-container-hours';
import { useMe } from '../../hooks/use-me';
import { formatDuration } from '../../lib/format-duration';
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
import { ContainerHoursBudgetEditor } from './budget-windows-editor';

/** The hours month is the container-hours window, so it reads as a period, not a month. */
const WINDOW_LABELS: Record<WindowKey, MessageKey> = {
	daily: 'budget.hours.today',
	weekly: 'budget.hours.thisWeek',
	monthly: 'budget.hours.thisPeriod',
};

function hoursFigures(s: ContainerHoursWindowStatus): WindowFigures {
	return { used: s.used_seconds, limit: s.limit_seconds, over: s.over_budget };
}

function hoursWindows(budget: ProjectContainerHoursBudget): Record<WindowKey, WindowFigures> {
	return {
		daily: hoursFigures(budget.daily),
		weekly: hoursFigures(budget.weekly),
		monthly: hoursFigures(budget.monthly),
	};
}

function storedLimits(budget: ProjectContainerHoursBudget): BudgetWindowsContainerSeconds {
	return {
		daily_budget_container_seconds: budget.daily.limit_seconds,
		weekly_budget_container_seconds: budget.weekly.limit_seconds,
		monthly_budget_container_seconds: budget.monthly.limit_seconds,
	};
}

/**
 * Where the instance allowance would stop this project first: a monthly limit
 * above the whole pool never binds. Read only by a superuser, who alone can
 * read the allowance and alone can set the limit, and only while editing.
 */
function AllowanceNote({ monthlySeconds }: { monthlySeconds: number }) {
	const { t, formatNumber } = useI18n();
	const { data } = useInstanceContainerHours(HoursBucket.Day);
	const allowanceHours = data?.monthly_hours ?? 0;
	if (allowanceHours <= 0 || monthlySeconds <= allowanceHours * 3600) return null;
	return (
		<p className="text-[12px] text-text-3" data-testid="hours-budget-above-allowance">
			{t('budget.hours.budget.aboveAllowance', { hours: formatNumber(allowanceHours) })}
		</p>
	);
}

/**
 * A project's hours budget: how long its containers may be up today, this week
 * and this period, against what they used.
 *
 * **Set by the instance owner alone.** The hours are one pool every project
 * draws on, so the edit control is a superuser's, and everyone else is told who
 * sets the limits rather than shown a control the server would refuse.
 *
 * **Shown only where it means something:** on a backend that bills uptime, or
 * wherever a limit is already set. On a local daemon an hour costs nothing, and
 * a card inviting a budget for it would be noise.
 */
export function ProjectHoursBudgetPanel({
	projectId,
	budget,
	periodEnd,
	metered,
}: {
	projectId: string;
	budget: ProjectContainerHoursBudget;
	/** When the container-hours window ends, which is when the monthly limit resets. */
	periodEnd: string;
	metered: boolean;
}) {
	const { t } = useI18n();
	const { data: me } = useMe();
	const resetCaption = useResetCaption();
	const save = useSetProjectContainerHoursBudget(projectId);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState<BudgetWindowsContainerSeconds>(() => storedLimits(budget));

	const windows = hoursWindows(budget);
	const anyLimit = WINDOW_KEYS.some((key) => windows[key].limit > 0);
	if (!metered && !anyLimit) return null;
	const canEdit = me?.is_superuser === true;

	function startEditing() {
		setDraft(storedLimits(budget));
		setEditing(true);
	}

	async function submit() {
		await save.mutateAsync(draft);
		setEditing(false);
	}

	const editButton = canEdit && !editing && (
		<Button variant="ghost" size="sm" onClick={startEditing} data-testid="edit-hours-budget">
			<Pencil className="h-3.5 w-3.5" aria-hidden />
			{t('budget.panel.editLimits')}
		</Button>
	);

	return (
		<section data-testid="hours-budget">
			<SectionHeader
				icon={Gauge}
				title={t('budget.hours.budget.title')}
				description={t('budget.hours.budget.description')}
				action={editButton || undefined}
			/>
			{editing ? (
				<form
					onSubmit={(e) => {
						e.preventDefault();
						void submit();
					}}
					className="flex flex-col gap-4"
				>
					<ContainerHoursBudgetEditor value={draft} onChange={setDraft} />
					<AllowanceNote monthlySeconds={draft.monthly_budget_container_seconds} />
					<div className="flex gap-2">
						<Button
							type="submit"
							size="sm"
							disabled={save.isPending}
							data-testid="save-hours-budget"
						>
							{save.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : t('common.save')}
						</Button>
						<Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
							{t('common.cancel')}
						</Button>
					</div>
				</form>
			) : (
				<>
					<div className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface shadow-xs sm:flex-row sm:divide-x sm:divide-y-0">
						{WINDOW_KEYS.map((key) => (
							<WindowColumn
								key={key}
								figures={windows[key]}
								label={t(WINDOW_LABELS[key])}
								format={formatDuration}
								resetCaption={resetCaption(key, new Date(periodEnd))}
								testId={`hours-budget-window-${key}`}
							/>
						))}
					</div>
					<BindingBanner
						windows={windows}
						labels={WINDOW_LABELS}
						testId="hours-budget-binding"
						body={(percent, limit, remaining) =>
							t('budget.hours.budget.binding', {
								percent,
								limit: formatDuration(limit),
								remaining: formatDuration(remaining),
							})
						}
						action={
							canEdit && (
								<Button
									variant="secondary"
									size="sm"
									className="w-full shrink-0 sm:w-auto"
									onClick={startEditing}
								>
									{t('budget.usage.binding.raise')}
								</Button>
							)
						}
					/>
					{!canEdit && (
						<p className="mt-2 text-[12px] text-text-3" data-testid="hours-budget-owner-only">
							{t('budget.hours.budget.ownerOnly')}
						</p>
					)}
				</>
			)}
		</section>
	);
}
