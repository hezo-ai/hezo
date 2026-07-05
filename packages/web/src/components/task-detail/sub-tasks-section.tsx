import { Link } from '@tanstack/react-router';
import { ChevronDown, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTasks } from '../../hooks/use-tasks';
import { DEFAULT_SUBTASK_PAGE_SIZE, useTeam } from '../../hooks/use-teams';
import { CreateTaskDialog } from '../create-task-dialog';
import { TaskRunDot } from '../task-run-dot';
import { TaskStatusBadge } from '../task-status-badge';

interface SubTasksSectionProps {
	projectId: string;
	parentTaskId: string;
	/** Parent's display identifier (e.g. "OPS-12"), shown in the create dialog title. */
	parentIdentifier: string;
	taskProjectSlug: string;
}

/**
 * Collapsible "Sub-tasks" card: a list of direct children with status
 * badges plus an "Add" button that opens the tailored create-task dialog
 * (parent fixed, assignee required). Paginated client-side by the team's
 * `subtask_page_size` setting so very busy parents don't blow up the layout.
 */
export function SubTasksSection({
	projectId,
	parentTaskId,
	parentIdentifier,
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
	const [createOpen, setCreateOpen] = useState(false);
	const [subTasksOpen, setSubTasksOpen] = useState(true);
	const [subTasksShownState, setSubTasksShownState] = useState<{
		taskId: string;
		count: number;
	} | null>(null);
	const subTasksShown =
		subTasksShownState && subTasksShownState.taskId === parentTaskId
			? subTasksShownState.count
			: subTaskPageSize;

	return (
		<div
			className="mb-5 rounded-md border border-border overflow-hidden"
			data-testid="sub-tasks-card"
		>
			<div className="flex items-center px-3 py-2 bg-surface-3">
				<button
					type="button"
					onClick={() => setSubTasksOpen((o) => !o)}
					className="flex items-center gap-2 flex-1 text-left cursor-pointer"
					data-testid="sub-tasks-toggle"
					aria-expanded={subTasksOpen}
				>
					<ChevronDown
						className={`w-3.5 h-3.5 text-text-3 transition-transform ${
							subTasksOpen ? '' : '-rotate-90'
						}`}
					/>
					<span className="text-xs font-medium text-text-2">Sub-tasks</span>
					<span className="bg-surface-2 px-[7px] py-px rounded-full text-[11px] text-text-2">
						{subTasks?.data.length ?? 0}
					</span>
				</button>
				<button
					type="button"
					onClick={() => {
						setSubTasksOpen(true);
						setCreateOpen(true);
					}}
					className="text-[11px] text-text-3 hover:text-text-1 flex items-center gap-1 cursor-pointer"
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
					{(subTasks?.data.length ?? 0) === 0 && (
						<span className="text-[13px] text-text-2">No sub-tasks.</span>
					)}
					{subTasks?.data.slice(0, subTasksShown).map((s) => (
						<Link
							key={s.id}
							to="/projects/$projectId/tasks/$taskId"
							params={{
								projectId: s.project_slug ?? taskProjectSlug,
								taskId: s.identifier.toLowerCase(),
							}}
							className="flex items-center gap-2 text-[13px] hover:bg-surface-2 rounded px-2 py-1"
							data-testid="sub-task-item"
						>
							<TaskStatusBadge status={s.status} className="shrink-0" />
							<TaskRunDot hasActiveRun={s.has_active_run} queuedWakeup={s.queued_wakeup} />
							<span className="font-mono text-xs text-text-2 shrink-0 whitespace-nowrap">
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
								className="inline-flex items-center gap-1.5 text-[12px] text-text-3 hover:text-text-1 px-3 py-1 rounded-md hover:bg-surface-2 transition-colors cursor-pointer"
								data-testid="sub-tasks-show-more"
							>
								<ChevronDown className="w-3 h-3" />
								Show more
								<span className="text-text-3">· {subTasks.data.length - subTasksShown} hidden</span>
							</button>
						</div>
					)}
				</div>
			)}
			<CreateTaskDialog
				projectId={projectId}
				parentTaskId={parentTaskId}
				parentIdentifier={parentIdentifier}
				open={createOpen}
				onOpenChange={setCreateOpen}
			/>
		</div>
	);
}
