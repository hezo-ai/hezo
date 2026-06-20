import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { type Task, useTaskAncestors } from '../../hooks/use-tasks';
import { MarkdownProse } from '../markdown-prose';
import { TaskPriorityBadge } from '../task-priority-badge';
import { TaskStatusBadge } from '../task-status-badge';
import { Badge } from '../ui/badge';

/** Compact wall-clock duration ("35s", "7m 41s", "1h 4m") from a seconds total. */
function formatDuration(totalSeconds: number): string {
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const mins = minutes % 60;
	return mins ? `${hours}h ${mins}m` : `${hours}h`;
}

interface TaskHeaderProps {
	task: Task;
	projectId: string;
	taskId: string;
	taskProjectSlug: string;
}

/**
 * Top-of-page header for a task: a breadcrumb of ancestor tasks ending in the
 * current identifier, then title, an inline mono metadata row (status · priority ·
 * assignee) with a runs · duration · cost summary, the queued-wakeup chip, and the
 * description card. Renders nothing status-mutating — assignee / close / reopen
 * live in the sidebar.
 */
export function TaskHeader({ task, projectId, taskId, taskProjectSlug }: TaskHeaderProps) {
	// Ancestors come back root-first, excluding the current task, so the
	// breadcrumb reads `root → … → parent → current`. Sub-tasks are capped at two
	// levels deep, so at most two links precede the current identifier. They share
	// the current task's project (sub-tasks inherit the parent's project), so the
	// current task's slug is the right link target.
	const { data: ancestors } = useTaskAncestors(projectId, taskId);
	return (
		<>
			<nav
				aria-label="Breadcrumb"
				className="mb-1 flex flex-wrap items-center gap-x-1 text-[13px] font-mono text-text-2"
				data-testid="task-breadcrumb"
			>
				{ancestors?.map((ancestor) => (
					<span key={ancestor.id} className="flex items-center gap-x-1">
						<Link
							to="/projects/$projectId/tasks/$taskId"
							params={{ projectId: taskProjectSlug, taskId: ancestor.identifier.toLowerCase() }}
							className="hover:text-text-1 hover:underline transition-colors"
							title={ancestor.title}
							data-testid="task-breadcrumb-ancestor"
						>
							{ancestor.identifier}
						</Link>
						<ChevronRight className="w-3 h-3 shrink-0 text-text-3" />
					</span>
				))}
				<span aria-current="page">{task.identifier}</span>
			</nav>
			<h1 className="text-xl font-medium mb-3">{task.title}</h1>

			{/* Wire spec — status / priority / assignee render as quiet-tint badges
			    (treatment A, the default), color-coding state at a glance the same way
			    the task list does, with a mono runs / duration / cost summary pushed
			    right. Assignee carries no semantic state, so it stays neutral. */}
			<div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1.5">
				<TaskStatusBadge status={task.status} testId="task-status-inline" />
				<TaskPriorityBadge priority={task.priority} testId="task-priority-inline" />
				{task.assignee_id && (
					<Badge color="neutral" className="max-w-[12rem]" testId="task-assignee-inline">
						<span className="truncate">{task.assignee_slug ?? task.assignee_name}</span>
					</Badge>
				)}
				{!task.has_active_run && task.queued_wakeup && (
					<Badge color="blue" className="gap-1" testId="task-queued-badge">
						<span className="inline-block w-1.5 h-1.5 rounded-full bg-info-soft-fg" />
						{task.queued_wakeup.reason === 'project_at_capacity'
							? 'Queued — project at capacity'
							: 'Run queued'}
					</Badge>
				)}
				{task.run_count > 0 && (
					<span
						className="font-mono text-[13px] text-text-3 sm:ml-auto"
						data-testid="task-run-summary"
					>
						{task.run_count} {task.run_count === 1 ? 'run' : 'runs'}
						{task.total_duration_seconds > 0 && ` · ${formatDuration(task.total_duration_seconds)}`}
						{task.total_cost_cents > 0 && ` · $${(task.total_cost_cents / 100).toFixed(2)}`}
					</span>
				)}
			</div>

			{task.description && (
				<div
					className="mb-5 rounded-md border border-border bg-surface overflow-hidden"
					data-testid="task-description-card"
				>
					<div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-surface-3">
						<span className="text-xs font-medium text-text-2">Description</span>
					</div>
					<div className="px-3 py-2.5">
						<MarkdownProse
							testId="task-description"
							projectId={projectId}
							projectSlug={taskProjectSlug}
						>
							{task.description}
						</MarkdownProse>
					</div>
				</div>
			)}
		</>
	);
}
