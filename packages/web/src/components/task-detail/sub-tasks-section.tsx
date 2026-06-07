import { Link } from '@tanstack/react-router';
import { ChevronDown, Plus } from 'lucide-react';
import { useState } from 'react';
import { useCreateSubTask, useTasks } from '../../hooks/use-tasks';
import { DEFAULT_SUBTASK_PAGE_SIZE, useTeam } from '../../hooks/use-teams';
import { TaskStatusBadge } from '../task-status-badge';
import { Button } from '../ui/button';

interface SubTasksSectionProps {
	projectId: string;
	taskId: string;
	parentTaskId: string;
	taskProjectSlug: string;
}

/**
 * Collapsible "Sub-tasks" card: a list of direct children with status
 * badges plus an inline form to create new ones. Paginated client-side
 * by the team's `subtask_page_size` setting so very busy parents don't
 * blow up the layout.
 */
export function SubTasksSection({
	projectId,
	taskId,
	parentTaskId,
	taskProjectSlug,
}: SubTasksSectionProps) {
	const { data: team } = useTeam(projectId);
	const subTaskPageSize = Math.max(
		1,
		team?.settings?.subtask_page_size ?? DEFAULT_SUBTASK_PAGE_SIZE,
	);
	const { data: subTasks } = useTasks(
		projectId,
		parentTaskId ? { parent_task_id: parentTaskId, per_page: '200' } : undefined,
		{ enabled: !!parentTaskId },
	);
	const createSubTask = useCreateSubTask(projectId, taskId);

	const [subTaskTitle, setSubTaskTitle] = useState('');
	const [showSubForm, setShowSubForm] = useState(false);
	const [subTasksOpen, setSubTasksOpen] = useState(true);
	const [subTasksShownState, setSubTasksShownState] = useState<{
		taskId: string;
		count: number;
	} | null>(null);
	const subTasksShown =
		subTasksShownState && subTasksShownState.taskId === parentTaskId
			? subTasksShownState.count
			: subTaskPageSize;

	async function handleSubTask(e: React.FormEvent) {
		e.preventDefault();
		if (!subTaskTitle.trim()) return;
		try {
			await createSubTask.mutateAsync({ title: subTaskTitle });
			setSubTaskTitle('');
			setShowSubForm(false);
		} catch {
			// error rendered below the form via createSubTask.error
		}
	}

	return (
		<div
			className="mb-5 rounded-md border border-border overflow-hidden"
			data-testid="sub-tasks-card"
		>
			<div className="flex items-center px-3 py-2 bg-bg-muted">
				<button
					type="button"
					onClick={() => setSubTasksOpen((o) => !o)}
					className="flex items-center gap-2 flex-1 text-left cursor-pointer"
					data-testid="sub-tasks-toggle"
					aria-expanded={subTasksOpen}
				>
					<ChevronDown
						className={`w-3.5 h-3.5 text-text-subtle transition-transform ${
							subTasksOpen ? '' : '-rotate-90'
						}`}
					/>
					<span className="text-xs font-medium text-text-muted">Sub-tasks</span>
					<span className="bg-bg-subtle px-[7px] py-px rounded-full text-[11px] text-text-muted">
						{subTasks?.data.length ?? 0}
					</span>
				</button>
				<button
					type="button"
					onClick={() => {
						setSubTasksOpen(true);
						setShowSubForm((s) => !s);
					}}
					className="text-[11px] text-text-subtle hover:text-text flex items-center gap-1 cursor-pointer"
					data-testid="sub-tasks-add"
				>
					<Plus className="w-3 h-3" /> Add
				</button>
			</div>
			{subTasksOpen && (
				<div
					className="px-3 py-2.5 flex flex-col gap-1.5 border-t border-border"
					data-testid="sub-tasks-list"
				>
					{showSubForm && (
						<>
							<form onSubmit={handleSubTask} className="flex gap-2 mb-1">
								<input
									value={subTaskTitle}
									onChange={(e) => setSubTaskTitle(e.target.value)}
									placeholder="Sub-task title"
									className="flex-1 rounded-radius-md border border-border bg-bg px-3 py-1.5 text-[13px] text-text outline-none focus:border-border-hover"
									data-testid="sub-task-title-input"
								/>
								<Button type="submit" size="sm" disabled={!subTaskTitle.trim()}>
									Create
								</Button>
							</form>
							{createSubTask.error && (
								<div className="text-[12px] text-red-500 mb-1" data-testid="sub-task-error">
									{(createSubTask.error as { message?: string }).message ??
										'Failed to create sub-task'}
								</div>
							)}
						</>
					)}
					{(subTasks?.data.length ?? 0) === 0 && !showSubForm && (
						<span className="text-[13px] text-text-muted">No sub-tasks.</span>
					)}
					{subTasks?.data.slice(0, subTasksShown).map((s) => (
						<Link
							key={s.id}
							to="/projects/$projectId/tasks/$taskId"
							params={{
								projectId: s.project_slug ?? taskProjectSlug,
								taskId: s.identifier.toLowerCase(),
							}}
							className="flex items-center gap-2 text-[13px] hover:bg-bg-subtle rounded px-2 py-1"
							data-testid="sub-task-item"
						>
							<TaskStatusBadge status={s.status} className="shrink-0" />
							<span className="font-mono text-xs text-text-muted shrink-0 whitespace-nowrap">
								{s.identifier}
							</span>
							<span className="truncate min-w-0">{s.title}</span>
						</Link>
					))}
					{subTasks && subTasks.data.length > subTasksShown && (
						<div className="flex justify-center pt-2 mt-0.5 border-t border-border-subtle">
							<button
								type="button"
								onClick={() =>
									setSubTasksShownState({
										taskId: parentTaskId,
										count: subTasksShown + subTaskPageSize,
									})
								}
								className="inline-flex items-center gap-1.5 text-[12px] text-text-subtle hover:text-text px-3 py-1 rounded-radius-md hover:bg-bg-subtle transition-colors cursor-pointer"
								data-testid="sub-tasks-show-more"
							>
								<ChevronDown className="w-3 h-3" />
								Show more
								<span className="text-text-subtle">
									· {subTasks.data.length - subTasksShown} hidden
								</span>
							</button>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
