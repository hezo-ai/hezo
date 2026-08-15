import {
	DASHBOARD_GOAL_SLOTS,
	formatGoalHealth,
	GoalHealth,
	type GoalWithProject,
	sortGoalsByTriage,
} from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { ChevronRight, Target } from 'lucide-react';
import { useI18n } from '../../lib/i18n';
import { Button } from '../ui/button';
import { Card } from '../ui/card';

/** Bar fill and health caption colour, keyed by the Captain's assessment. */
const HEALTH_FILL: Record<string, string> = {
	[GoalHealth.OnTrack]: 'bg-success',
	[GoalHealth.AtRisk]: 'bg-warning',
	[GoalHealth.OffTrack]: 'bg-danger',
	[GoalHealth.Pending]: 'bg-text-3',
};

const HEALTH_TEXT: Record<string, string> = {
	[GoalHealth.OnTrack]: 'text-success-soft-fg',
	[GoalHealth.AtRisk]: 'text-warning-soft-fg',
	[GoalHealth.OffTrack]: 'text-danger-soft-fg',
	[GoalHealth.Pending]: 'text-text-3',
};

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, Math.round(value)));
}

function GoalSlot({ projectId, goal }: { projectId: string; goal: GoalWithProject }) {
	const { formatDate } = useI18n();
	const percent = clampPercent(goal.progress_percent);
	return (
		<Link
			to="/projects/$projectId/goals/$goalId"
			params={{ projectId, goalId: goal.id }}
			data-testid="dashboard-goal-slot"
			className="flex flex-col justify-center gap-1.5 px-3 py-2.5 hover:bg-surface-2"
		>
			<div className="flex items-baseline gap-2">
				<span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-text-1">
					{goal.title}
				</span>
				<span
					className={`shrink-0 font-mono text-[11px] tabular-nums ${
						goal.health === GoalHealth.OffTrack ? 'text-danger' : 'text-text-3'
					}`}
				>
					{percent}%
				</span>
			</div>
			<div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
				<div
					className={`h-full rounded-full ${HEALTH_FILL[goal.health] ?? HEALTH_FILL[GoalHealth.Pending]}`}
					style={{ width: `${percent}%` }}
				/>
			</div>
			<div className="flex items-center gap-1.5 text-[10.5px]">
				<span className={HEALTH_TEXT[goal.health] ?? 'text-text-3'}>
					{formatGoalHealth(goal.health)}
				</span>
				{goal.target_date && (
					<span className="truncate text-text-3">· {formatDate(goal.target_date)}</span>
				)}
			</div>
		</Link>
	);
}

/**
 * The dashboard's goals card: a fixed number of slots, so the card is the same height whether a
 * project has four goals or forty and the two dashboard columns bottom out level.
 *
 * With more goals than slots the last slot becomes a link to the rest, and the goals shown are
 * ranked worst-health-first: a capped list should spend its slots on the ones needing a decision.
 * The Goals page keeps the full list in its own stable order.
 */
export function DashboardGoals({
	projectId,
	goals,
}: {
	projectId: string;
	goals: GoalWithProject[];
}) {
	const { t, plural } = useI18n();
	const active = goals.filter((g) => !g.archived_at);

	if (active.length === 0) {
		return (
			<section data-testid="dashboard-goals">
				<div className="mb-2 flex items-center gap-2">
					<Target className="h-4 w-4 shrink-0 text-text-3" aria-hidden="true" />
					<h2 className="text-[12.5px] font-medium text-text-1">{t('nav.goals')}</h2>
				</div>
				<div
					data-testid="dashboard-goals-empty"
					className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border-strong px-3 py-5 text-center"
				>
					<p className="text-[12.5px] text-text-2">{t('dashboard.goals.emptyTitle')}</p>
					<p className="text-[11.5px] text-text-3">{t('dashboard.goals.emptyHint')}</p>
					<Link to="/projects/$projectId/goals" params={{ projectId }}>
						<Button variant="secondary" size="sm">
							{t('progress.goals.empty')}
						</Button>
					</Link>
				</div>
			</section>
		);
	}

	// One slot is spent on the "+N more" link only when there is actually more to show, so a
	// project sitting exactly on the cap still gets every goal rendered.
	const overflowing = active.length > DASHBOARD_GOAL_SLOTS;
	const shown = sortGoalsByTriage(active).slice(
		0,
		overflowing ? DASHBOARD_GOAL_SLOTS - 1 : DASHBOARD_GOAL_SLOTS,
	);
	const remaining = active.length - shown.length;

	return (
		<section data-testid="dashboard-goals">
			<div className="mb-2 flex items-center gap-2">
				<Target className="h-4 w-4 shrink-0 text-text-3" aria-hidden="true" />
				<h2 className="text-[12.5px] font-medium text-text-1">{t('nav.goals')}</h2>
				<Link
					to="/projects/$projectId/goals"
					params={{ projectId }}
					className="ml-auto text-[11px] text-info-soft-fg hover:underline"
				>
					{t('dashboard.goals.viewAll', { count: active.length })}
				</Link>
			</div>
			<Card className="divide-y divide-border p-0">
				{shown.map((goal) => (
					<GoalSlot key={goal.id} projectId={projectId} goal={goal} />
				))}
				{overflowing && (
					<Link
						to="/projects/$projectId/goals"
						params={{ projectId }}
						data-testid="dashboard-goals-more"
						className="flex items-center gap-2 bg-surface-2 px-3 py-2 text-[11.5px] text-info-soft-fg hover:bg-surface-3"
					>
						{plural('dashboard.goals.more', remaining)}
						<ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0" aria-hidden="true" />
					</Link>
				)}
			</Card>
		</section>
	);
}
