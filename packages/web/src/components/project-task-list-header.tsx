import {
	ProjectTaskListPhaseBanner as PhaseBannerKind,
	type TaskProgressSummary,
} from '@hezo/shared';
import { useTaskProgressSummary } from '../hooks/use-task-progress-summary';
import { ProjectStatusBadge } from './project-status-badge';

const bannerClass =
	'mb-4 rounded-md border border-border bg-bg-elevated px-3 py-2.5 sm:px-4 text-sm text-text';

function PhaseBanner({ summary }: { summary: TaskProgressSummary }) {
	if (summary.phase_banner === PhaseBannerKind.Onboarding) {
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

	return (
		<div
			data-testid="project-task-list-phase-banner-planning"
			className={bannerClass}
			role="status"
		>
			<div className="flex flex-wrap items-center gap-2 min-w-0">
				{summary.project_status && <ProjectStatusBadge status={summary.project_status} />}
				<span className="font-medium">{summary.project_name} - Planning phase</span>
			</div>
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
			className="mb-4 rounded-md border border-border bg-bg-elevated px-3 py-3 sm:px-4"
		>
			<div className="flex flex-wrap items-center justify-between gap-2 mb-2">
				<div className="flex flex-wrap items-center gap-2 min-w-0">
					{project_status && <ProjectStatusBadge status={project_status} />}
					<span className="text-sm font-medium text-text">{percent_complete}% complete</span>
				</div>
				<span className="text-xs text-text-muted shrink-0">
					{complete} of {total} tasks
				</span>
			</div>
			<div
				className="h-2 rounded-full bg-bg-muted overflow-hidden flex"
				role="progressbar"
				aria-valuenow={percent_complete}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-label={`${percent_complete}% of execution tasks complete`}
			>
				{completePct > 0 && (
					<div
						data-testid="task-progress-segment-complete"
						className="h-full bg-accent-green shrink-0"
						style={{ width: `${completePct}%` }}
					/>
				)}
				{inProgressPct > 0 && (
					<div
						data-testid="task-progress-segment-in-progress"
						className="h-full bg-accent-amber shrink-0"
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
			<div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-text-muted">
				<span className="inline-flex items-center gap-1.5">
					<span className="w-2 h-2 rounded-full bg-accent-green shrink-0" />
					{complete} complete
				</span>
				<span className="inline-flex items-center gap-1.5">
					<span className="w-2 h-2 rounded-full bg-accent-amber shrink-0" />
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
			{summary.phase_banner && <PhaseBanner summary={summary} />}
			{showProgressBar && <ProgressBar summary={summary} />}
		</>
	);
}
