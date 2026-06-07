import { Link } from '@tanstack/react-router';
import { Trash2 } from 'lucide-react';
import {
	type TaskDependency,
	useRemoveDependency,
	useTaskDependencies,
} from '../../hooks/use-tasks';
import { TaskStatusBadge } from '../task-status-badge';

interface DependenciesSectionProps {
	projectId: string;
	taskId: string;
}

/**
 * "Blocked By" list — every dependency the task is waiting on, with a trash
 * button to clear the link. Hidden when the task has no dependencies; the
 * route file unconditionally renders this component and lets it decide.
 */
export function DependenciesSection({ projectId, taskId }: DependenciesSectionProps) {
	const { data: deps } = useTaskDependencies(projectId, taskId);
	const removeDep = useRemoveDependency(projectId, taskId);

	if (!deps || deps.length === 0) return null;

	return (
		<div className="mb-5">
			<h3 className="text-xs font-medium uppercase tracking-wider text-text-muted mb-2">
				Blocked By
			</h3>
			<div className="flex flex-col gap-1">
				{deps.map((d: TaskDependency) => (
					<div key={d.id} className="flex items-center gap-2">
						<Link
							to="/projects/$projectId/tasks/$taskId"
							params={{
								projectId: d.blocked_by_project_slug,
								taskId: d.blocked_by_identifier.toLowerCase(),
							}}
							className="flex items-center gap-2 text-[13px] hover:bg-bg-subtle rounded px-2 py-1 flex-1 min-w-0"
							data-testid="blocked-by-item"
						>
							<TaskStatusBadge status={d.blocked_by_status} />
							<span className="font-mono text-xs text-text-muted">{d.blocked_by_identifier}</span>
							<span className="truncate">{d.blocked_by_title}</span>
						</Link>
						<button
							type="button"
							onClick={() => removeDep.mutate(d.id)}
							className="text-text-subtle hover:text-accent-red"
						>
							<Trash2 className="w-3 h-3" />
						</button>
					</div>
				))}
			</div>
		</div>
	);
}
