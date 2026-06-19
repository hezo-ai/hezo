import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { type Task, useTaskAncestors } from '../../hooks/use-tasks';
import { MarkdownProse } from '../markdown-prose';
import { TaskStatusBadge } from '../task-status-badge';
import { Badge } from '../ui/badge';

const priorityColors: Record<string, string> = {
	urgent: 'danger',
	high: 'warning',
	medium: 'info',
	low: 'neutral',
};

interface TaskHeaderProps {
	task: Task;
	projectId: string;
	taskId: string;
	taskProjectSlug: string;
}

/**
 * Top-of-page header for a task: a breadcrumb of ancestor tasks ending in the
 * current identifier, then title, status / priority / project badges,
 * queued-wakeup chip, and the description card. Renders nothing status-mutating
 * — assignee / close / reopen live in the sidebar.
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
				className="mb-1 flex flex-wrap items-center gap-x-1 text-[13px] font-mono text-text-muted"
				data-testid="task-breadcrumb"
			>
				{ancestors?.map((ancestor) => (
					<span key={ancestor.id} className="flex items-center gap-x-1">
						<Link
							to="/projects/$projectId/tasks/$taskId"
							params={{ projectId: taskProjectSlug, taskId: ancestor.identifier.toLowerCase() }}
							className="hover:text-text hover:underline transition-colors"
							title={ancestor.title}
							data-testid="task-breadcrumb-ancestor"
						>
							{ancestor.identifier}
						</Link>
						<ChevronRight className="w-3 h-3 shrink-0 text-text-subtle" />
					</span>
				))}
				<span aria-current="page">{task.identifier}</span>
			</nav>
			<h1 className="text-xl font-medium mb-3">{task.title}</h1>

			<div className="flex flex-wrap gap-1.5 mb-4">
				<TaskStatusBadge status={task.status} />
				<Badge color={priorityColors[task.priority] as 'neutral'}>{task.priority}</Badge>
				{task.project_name && task.project_slug && (
					<Link
						to="/projects/$projectId"
						params={{ projectId: task.project_slug }}
						className="hover:opacity-80 transition-opacity"
					>
						<Badge color="info">{task.project_name}</Badge>
					</Link>
				)}
				{!task.has_active_run && task.queued_wakeup && (
					<Badge color="blue" className="gap-1" data-testid="task-queued-badge">
						<span className="inline-block w-1.5 h-1.5 rounded-full bg-accent-blue-text" />
						{task.queued_wakeup.reason === 'project_at_capacity'
							? 'Queued — project at capacity'
							: 'Run queued'}
					</Badge>
				)}
			</div>

			{task.description && (
				<div
					className="mb-5 rounded-md border border-border bg-bg-elevated overflow-hidden"
					data-testid="task-description-card"
				>
					<div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-bg-muted">
						<span className="text-xs font-medium text-text-muted">Description</span>
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
