import { createFileRoute, Link } from '@tanstack/react-router';
import { TaskStatusBadge } from '../../../components/task-status-badge';
import { type GlobalTask, useAllTasks } from '../../../hooks/use-tasks';
import { useTeams } from '../../../hooks/use-teams';

function row(t: GlobalTask) {
	return (
		<li key={t.id}>
			<Link
				to="/teams/$teamId/tasks/$taskId"
				params={{ teamId: t.team_slug, taskId: t.identifier.toLowerCase() }}
				className="block border border-border rounded-radius-md p-3 hover:border-border-hover transition-colors"
			>
				<div className="flex items-center justify-between gap-3">
					<span className="text-[14px] truncate">
						<span className="font-mono text-text-muted mr-1.5">{t.identifier}</span>
						{t.title}
					</span>
					<TaskStatusBadge status={t.status} />
				</div>
				<div className="text-[12px] text-text-muted mt-1 truncate">
					{t.team_name} · {t.project_name ?? 'No project'} · {t.assignee_name ?? 'Unassigned'}
				</div>
			</Link>
		</li>
	);
}

function AllTasksPage() {
	const { data: teams } = useTeams();
	const { data: tasks, isLoading } = useAllTasks(teams ?? []);

	return (
		<div
			className="max-w-7xl mx-auto w-full px-4 py-4 md:px-6 md:py-5 lg:px-8 lg:py-6"
			data-testid="all-tasks-page"
		>
			<h1 className="text-[22px] font-medium mb-5">All Tasks</h1>
			{isLoading ? (
				<div className="text-text-muted text-[13px]">Loading tasks…</div>
			) : (tasks ?? []).length === 0 ? (
				<div className="text-text-muted text-[13px]" data-testid="all-tasks-empty">
					No tasks across your teams yet.
				</div>
			) : (
				<ul className="flex flex-col gap-2" data-testid="all-tasks-list">
					{(tasks ?? []).map(row)}
				</ul>
			)}
		</div>
	);
}

export const Route = createFileRoute('/home/tasks/')({
	component: AllTasksPage,
});
