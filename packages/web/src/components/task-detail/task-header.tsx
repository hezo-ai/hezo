import { Link } from '@tanstack/react-router';
import type { Task } from '../../hooks/use-tasks';
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
	teamId: string;
	taskProjectSlug: string;
}

/**
 * Top-of-page header for a task: identifier, title, status / priority / project
 * badges, queued-wakeup chip, and the description card. Renders nothing
 * status-mutating — assignee / close / reopen live in the sidebar.
 */
export function TaskHeader({ task, teamId, taskProjectSlug }: TaskHeaderProps) {
	return (
		<>
			<div className="mb-1 text-[13px] font-mono text-text-muted">{task.identifier}</div>
			<h1 className="text-xl font-medium mb-3">{task.title}</h1>

			<div className="flex flex-wrap gap-1.5 mb-4">
				<TaskStatusBadge status={task.status} />
				<Badge color={priorityColors[task.priority] as 'neutral'}>{task.priority}</Badge>
				{task.project_name && task.project_slug && (
					<Link
						to="/teams/$teamId/projects/$projectId"
						params={{ teamId, projectId: task.project_slug }}
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
						<MarkdownProse testId="task-description" teamId={teamId} projectSlug={taskProjectSlug}>
							{task.description}
						</MarkdownProse>
					</div>
				</div>
			)}
		</>
	);
}
