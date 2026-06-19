import type { TaskProgressSummary } from '@hezo/shared';
import { useTaskProgressSummary } from '../hooks/use-task-progress-summary';
import { ProjectStatusBadge } from './project-status-badge';

const bannerClass =
	'mb-4 rounded-md border border-border bg-surface px-3 py-2.5 sm:px-4 text-sm text-text-1';

function OnboardingBanner() {
	return (
		<div
			data-testid="project-task-list-phase-banner-onboarding"
			className={bannerClass}
			role="status"
		>
			Please wait whilst the CEO onboards your new team members
		</div>
	);
}

function ProgressBar({ summary }: { summary: TaskProgressSummary }) {
	const { total, complete, in_progress, not_done, percent_complete, project_status } = summary;

	const completePct = (complete / total) * 100;
	const inProgressPct = (in_progress / total) * 100;
	const notDonePct = (not_done / total) * 100;

	return (
		<div
			data-testid="task-progress-bar"
			className="mb-4 rounded-md border border-border bg-surface px-3 py-3 sm:px-4"
		>
			<div className="flex flex-wrap items-center justify-between gap-2 mb-2">
				<div className="flex flex-wrap items-center gap-2 min-w-0">
					{project_status && <ProjectStatusBadge status={project_status} />}
					<span className="text-sm font-medium text-text-1">{percent_complete}% complete</span>
				</div>
				<span className="text-xs text-text-2 shrink-0">
					{complete} of {total} tasks
				</span>
			</div>
			<div
				className="h-2 rounded-full bg-surface-3 overflow-hidden flex"
				role="progressbar"
				aria-valuenow={percent_complete}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-label={`${percent_complete}% of execution tasks complete`}
			>
				{completePct > 0 && (
					<div
						data-testid="task-progress-segment-complete"
						className="h-full bg-success shrink-0"
						style={{ width: `${completePct}%` }}
					/>
				)}
				{inProgressPct > 0 && (
					<div
						data-testid="task-progress-segment-in-progress"
						className="h-full bg-warning shrink-0"
						style={{ width: `${inProgressPct}%` }}
					/>
				)}
				{notDonePct > 0 && (
					<div
						data-testid="task-progress-segment-not-done"
						className="h-full bg-border shrink-0"
						style={{ width: `${notDonePct}%` }}
					/>
				)}
			</div>
			<div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-text-2">
				<span className="inline-flex items-center gap-1.5">
					<span className="w-2 h-2 rounded-full bg-success shrink-0" />
					{complete} complete
				</span>
				<span className="inline-flex items-center gap-1.5">
					<span className="w-2 h-2 rounded-full bg-warning shrink-0" />
					{in_progress} in progress
				</span>
				<span className="inline-flex items-center gap-1.5">
					<span className="w-2 h-2 rounded-full bg-border shrink-0" />
					{not_done} waiting
				</span>
			</div>
		</div>
	);
}

export function ProjectTaskListHeader({ projectId }: { projectId: string }) {
	const { data: summary, isLoading } = useTaskProgressSummary(projectId);

	if (isLoading || !summary) return null;

	const showProgressBar = summary.planning_complete && summary.total > 0;

	if (!summary.phase_banner && !showProgressBar) return null;

	return (
		<>
			{summary.phase_banner && <OnboardingBanner />}
			{showProgressBar && <ProgressBar summary={summary} />}
		</>
	);
}
