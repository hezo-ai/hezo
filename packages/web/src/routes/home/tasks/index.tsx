import { createFileRoute, Link } from '@tanstack/react-router';
import { TaskStatusBadge } from '../../../components/task-status-badge';
import { InfoTooltip } from '../../../components/ui/info-tooltip';
import { useAllVisibleProjects } from '../../../hooks/use-projects';
import { type GlobalTask, useAllTasks } from '../../../hooks/use-tasks';

function row(t: GlobalTask) {
	return (
		<li key={t.id}>
			<Link
				to="/projects/$projectId/tasks/$taskId"
				params={{ projectId: t.project_slug ?? '', taskId: t.identifier.toLowerCase() }}
				className="block border border-border rounded-md p-3 hover:border-border-strong transition-colors"
			>
				<div className="flex items-center justify-between gap-3">
					<span className="text-[14px] truncate">
						<span className="font-mono text-text-2 mr-1.5">{t.identifier}</span>
						{t.title}
					</span>
					<TaskStatusBadge status={t.status} />
				</div>
				<div className="text-[12px] text-text-2 mt-1 truncate">
					{t.team_name} · {t.project_name ?? 'No project'} · {t.assignee_name ?? 'Unassigned'}
				</div>
			</Link>
		</li>
	);
}

function AllTasksPage() {
	const { projects } = useAllVisibleProjects();
	const { data: tasks, isLoading } = useAllTasks(projects);

	return (
		<div
			className="max-w-7xl mx-auto w-full px-4 py-4 md:px-6 md:py-5 lg:px-8 lg:py-6"
			data-testid="all-tasks-page"
		>
			<div className="flex items-center gap-1.5 mb-5">
				<h1 className="text-[22px] font-medium">All Tasks</h1>
				<InfoTooltip
					label="About the All Tasks page"
					content="Every task across every project and team you can see, in one list."
					data-testid="all-tasks-info"
				/>
			</div>
			{isLoading ? (
				<div className="text-text-2 text-[13px]">Loading tasks…</div>
			) : (tasks ?? []).length === 0 ? (
				<div className="text-text-2 text-[13px]" data-testid="all-tasks-empty">
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
