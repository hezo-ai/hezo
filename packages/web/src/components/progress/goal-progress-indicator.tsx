import { GoalHealth, type GoalWithProject } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { useI18n } from '../../lib/i18n';

/**
 * How far along the project's goals are, shown beside the progress summary. One bar per goal,
 * filled to that goal's own percent and tinted by its health, so the control answers both
 * "how far along overall" and "is any single goal in trouble" without a click. The whole thing
 * is one link to the Goals page.
 *
 * Health drives colour rather than the percent does: a goal at 80% that the Captain has marked
 * off track should read as a problem, not as nearly done.
 */
const HEALTH_FILL: Record<string, string> = {
	[GoalHealth.OnTrack]: 'bg-success',
	[GoalHealth.AtRisk]: 'bg-warning',
	[GoalHealth.OffTrack]: 'bg-danger',
	[GoalHealth.Pending]: 'bg-text-3',
};

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, Math.round(value)));
}

export function GoalProgressIndicator({
	projectId,
	goals,
	className,
}: {
	projectId: string;
	goals: GoalWithProject[];
	className?: string;
}) {
	const { t } = useI18n();
	const active = goals.filter((g) => !g.archived_at);

	// No goals yet: the indicator becomes the nudge to create one, pointing at the same page.
	if (active.length === 0) {
		return (
			<Link
				to="/projects/$projectId/progress/goals"
				params={{ projectId }}
				data-testid="goal-progress-indicator-empty"
				className={`inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-2.5 py-1.5 text-xs text-text-2 transition-colors hover:border-border-strong hover:text-text-1 ${className ?? ''}`}
			>
				{t('progress.goals.empty')}
				<ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-3" aria-hidden="true" />
			</Link>
		);
	}

	const overall = clampPercent(
		active.reduce((sum, g) => sum + clampPercent(g.progress_percent), 0) / active.length,
	);
	const offTrack = active.filter((g) => g.health === GoalHealth.OffTrack).length;

	return (
		<Link
			to="/projects/$projectId/progress/goals"
			params={{ projectId }}
			data-testid="goal-progress-indicator"
			aria-label={t('progress.goals.view')}
			className={`group -mx-2 -my-1 inline-flex items-center gap-2.5 rounded-md border border-transparent px-2 py-1 transition-colors hover:border-border hover:bg-surface-2 ${className ?? ''}`}
		>
			<span className="flex w-[132px] shrink-0 gap-[3px]" aria-hidden="true">
				{active.map((goal) => (
					<span
						key={goal.id}
						title={`${goal.title} - ${clampPercent(goal.progress_percent)}%`}
						data-testid="goal-progress-segment"
						className="relative h-[22px] flex-1 overflow-hidden rounded-[3px] bg-surface-3"
					>
						<span
							className={`absolute bottom-0 left-0 w-full rounded-[3px] ${HEALTH_FILL[goal.health] ?? HEALTH_FILL[GoalHealth.Pending]}`}
							style={{ height: `${clampPercent(goal.progress_percent)}%` }}
						/>
					</span>
				))}
			</span>
			<span className="flex min-w-0 flex-col items-start">
				<span
					data-testid="goal-progress-percent"
					className="text-[15px] font-semibold leading-tight text-text-1 tabular-nums"
				>
					{overall}%
				</span>
				<span className="whitespace-nowrap text-[11px] text-text-3">
					{t('progress.goals.count', { count: active.length })}
					{offTrack > 0 && ` · ${t('progress.goals.offTrack', { count: offTrack })}`}
				</span>
			</span>
			<ChevronRight
				className="h-3.5 w-3.5 shrink-0 text-text-3 transition-colors group-hover:text-text-1"
				aria-hidden="true"
			/>
		</Link>
	);
}
