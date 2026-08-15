import { DASHBOARD_IN_PROGRESS_LIMIT, TaskStatus } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { ListTodo } from 'lucide-react';
import { useTasks } from '../../hooks/use-tasks';
import { useI18n } from '../../lib/i18n';
import { TaskRunDot } from '../task-run-dot';
import { TaskStatusBadge } from '../task-status-badge';
import { Card } from '../ui/card';

/**
 * The work in flight: tasks in progress or review, most recently touched first.
 *
 * Capped at `DASHBOARD_IN_PROGRESS_LIMIT` with a link to the full list. That number is the left
 * column's floor and is chosen against the goals card's slot count, so the two dashboard columns
 * bottom out level - changing one without the other unbalances the grid.
 */
export function InProgressTasks({ projectId }: { projectId: string }) {
	const { t } = useI18n();
	const { data } = useTasks(projectId, {
		status: `${TaskStatus.InProgress},${TaskStatus.Review}`,
		sort: 'updated_at:desc',
		// One over the cap, so "there is more" is known without a second count query.
		per_page: String(DASHBOARD_IN_PROGRESS_LIMIT + 1),
	});
	const all = data?.data ?? [];
	const tasks = all.slice(0, DASHBOARD_IN_PROGRESS_LIMIT);
	const hasMore = all.length > DASHBOARD_IN_PROGRESS_LIMIT;

	return (
		<section data-testid="dashboard-in-progress">
			<div className="mb-2 flex items-center gap-2">
				<ListTodo className="h-4 w-4 shrink-0 text-text-3" aria-hidden="true" />
				<h2 className="text-[12.5px] font-medium text-text-1">
					{t('dashboard.inProgress.heading')}
				</h2>
				<Link
					to="/projects/$projectId/tasks"
					params={{ projectId }}
					className="ml-auto text-[11px] text-info-soft-fg hover:underline"
				>
					{t('dashboard.inProgress.viewTasks')}
				</Link>
			</div>
			{tasks.length === 0 ? (
				<Card className="flex min-h-[88px] items-center justify-center px-4 py-3">
					<div className="text-center">
						<h3 className="text-sm font-medium text-text-1">
							{t('dashboard.inProgress.emptyTitle')}
						</h3>
						<p className="mt-1 text-sm text-text-2">{t('dashboard.inProgress.emptyHint')}</p>
					</div>
				</Card>
			) : (
				<Card className="divide-y divide-border p-0">
					{tasks.map((task) => (
						<Link
							key={task.id}
							to="/projects/$projectId/tasks/$taskId"
							params={{ projectId, taskId: task.identifier.toLowerCase() }}
							className="flex items-center gap-3 px-3 py-2.5 hover:bg-surface-2"
							data-testid="dashboard-task-row"
						>
							<TaskRunDot hasActiveRun={task.has_active_run} queuedWakeup={task.queued_wakeup} />
							<span className="shrink-0 font-mono text-[12px] text-text-3">{task.identifier}</span>
							<span className="min-w-0 flex-1 truncate text-[13px] text-text-1">{task.title}</span>
							{task.assignee_name && (
								<span className="hidden shrink-0 text-[12px] text-text-3 sm:inline">
									{task.assignee_name}
								</span>
							)}
							<TaskStatusBadge status={task.status} />
						</Link>
					))}
					{hasMore && (
						<Link
							to="/projects/$projectId/tasks"
							params={{ projectId }}
							data-testid="dashboard-in-progress-more"
							className="block bg-surface-2 px-3 py-2 text-[11.5px] text-info-soft-fg hover:bg-surface-3"
						>
							{t('dashboard.inProgress.more')}
						</Link>
					)}
				</Card>
			)}
		</section>
	);
}
