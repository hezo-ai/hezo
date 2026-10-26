import { Link } from '@tanstack/react-router';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
	type TaskDependency,
	useRemoveDependency,
	useTaskDependencies,
} from '../../hooks/use-tasks';
import { useI18n } from '../../lib/i18n';
import { TaskRunDot } from '../task-run-dot';
import { TaskStatusBadge } from '../task-status-badge';
import { ConfirmDialog } from '../ui/confirm-dialog';

interface DependenciesSectionProps {
	projectId: string;
	taskId: string;
}

/**
 * "Blocked By" list — every dependency the task is waiting on, with a trash
 * button that asks before it clears the link. Hidden when the task has no
 * dependencies; the route file unconditionally renders this component and lets
 * it decide.
 */
export function DependenciesSection({ projectId, taskId }: DependenciesSectionProps) {
	const { data: deps } = useTaskDependencies(projectId, taskId);
	const removeDep = useRemoveDependency(projectId, taskId);
	const { t } = useI18n();
	const [pendingRemoval, setPendingRemoval] = useState<TaskDependency | null>(null);

	if (!deps || deps.length === 0) return null;

	return (
		<div className="mb-5">
			<h3 className="text-xs font-medium uppercase tracking-wider text-text-2 mb-2">Blocked By</h3>
			<div className="flex flex-col gap-1">
				{deps.map((d: TaskDependency) => (
					<div key={d.id} className="flex items-center gap-2">
						<Link
							to="/projects/$projectId/tasks/$taskId"
							params={{
								projectId: d.blocked_by_project_slug,
								taskId: d.blocked_by_identifier.toLowerCase(),
							}}
							className="flex items-center gap-2 text-[13px] hover:bg-surface-2 rounded px-2 py-1 flex-1 min-w-0"
							data-testid="blocked-by-item"
						>
							<TaskStatusBadge status={d.blocked_by_status} />
							<TaskRunDot
								hasActiveRun={d.blocked_by_has_active_run}
								queuedWakeup={d.blocked_by_queued_wakeup}
							/>
							<span className="font-mono text-xs text-text-2">{d.blocked_by_identifier}</span>
							<span className="truncate">{d.blocked_by_title}</span>
						</Link>
						<button
							type="button"
							onClick={() => setPendingRemoval(d)}
							aria-label={t('tasks.dependency.remove.label', { task: d.blocked_by_identifier })}
							className="text-text-3 hover:text-danger"
						>
							<Trash2 className="w-3 h-3" />
						</button>
					</div>
				))}
			</div>
			<ConfirmDialog
				open={pendingRemoval !== null}
				onOpenChange={(open) => {
					if (!open) setPendingRemoval(null);
				}}
				title={
					pendingRemoval
						? t('tasks.dependency.remove.title', { task: pendingRemoval.blocked_by_identifier })
						: ''
				}
				description={
					pendingRemoval
						? t('tasks.dependency.remove.description', {
								task: pendingRemoval.blocked_by_identifier,
							})
						: ''
				}
				confirmLabel={t('common.remove')}
				variant="danger"
				loading={removeDep.isPending}
				onConfirm={async () => {
					if (pendingRemoval) await removeDep.mutateAsync(pendingRemoval.id);
				}}
			/>
		</div>
	);
}
