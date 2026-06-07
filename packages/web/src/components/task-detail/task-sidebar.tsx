import {
	AgentEffort,
	AgentRuntimeStatus,
	CAPTAIN_AGENT_SLUG,
	DEFAULT_EFFORT,
	INTERNAL_PROJECT_SLUG,
	TaskStatus,
} from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { ArrowDown, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Agent } from '../../hooks/use-agents';
import type { Comment } from '../../hooks/use-comments';
import type { ExecutionLockState } from '../../hooks/use-execution-locks';
import { useQueuedWakeups } from '../../hooks/use-queued-wakeups';
import type { Task, useUpdateTask } from '../../hooks/use-tasks';
import { AgentStatusLabel } from '../agent-status-label';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { InfoTooltip } from '../ui/info-tooltip';
import { AgentQueueSection } from './agent-queue-section';

const EFFORT_LEVELS: { value: AgentEffort; label: string }[] = [
	{ value: AgentEffort.Minimal, label: 'Minimal' },
	{ value: AgentEffort.Low, label: 'Low' },
	{ value: AgentEffort.Medium, label: 'Medium' },
	{ value: AgentEffort.High, label: 'High' },
	{ value: AgentEffort.Max, label: 'Max (ultrathink)' },
];

interface TaskSidebarProps {
	task: Task;
	projectId: string;
	agents: Agent[] | undefined;
	lock: ExecutionLockState | undefined;
	comments: Comment[] | undefined;
	updateTask: ReturnType<typeof useUpdateTask>;
	commentEffort: AgentEffort | null;
	setCommentEffort: (v: AgentEffort | null) => void;
	atBottom: boolean;
	scrollToBottom: () => void;
}

export function TaskSidebar({
	task,
	projectId,
	agents,
	lock,
	comments,
	updateTask,
	commentEffort,
	setCommentEffort,
	atBottom,
	scrollToBottom,
}: TaskSidebarProps) {
	const [assigneeOpen, setAssigneeOpen] = useState(false);
	const [closeOpen, setCloseOpen] = useState(false);
	const [reopenOpen, setReopenOpen] = useState(false);
	const assigneeRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!assigneeOpen) return;
		function onPointerDown(e: PointerEvent) {
			if (assigneeRef.current && !assigneeRef.current.contains(e.target as Node)) {
				setAssigneeOpen(false);
			}
		}
		document.addEventListener('pointerdown', onPointerDown);
		return () => document.removeEventListener('pointerdown', onPointerDown);
	}, [assigneeOpen]);

	const { data: queued } = useQueuedWakeups(projectId, task.id);

	const assignedAgent = agents?.find((a) => a.id === task.assignee_id);
	const effectiveDefaultEffort: AgentEffort =
		assignedAgent?.slug === CAPTAIN_AGENT_SLUG
			? AgentEffort.Max
			: (assignedAgent?.default_effort ?? DEFAULT_EFFORT);
	const isInternalProject = task.project_slug === INTERNAL_PROJECT_SLUG;
	const assigneeOptions = agents
		?.filter((a) => a.admin_status !== 'disabled')
		.filter((a) => !isInternalProject || a.slug === CAPTAIN_AGENT_SLUG);

	return (
		<>
			<div
				data-testid="task-sidebar"
				className="flex flex-col gap-4 text-xs lg:sticky lg:top-0 lg:self-start"
			>
				<AgentQueueSection
					projectId={projectId}
					taskId={task.id}
					locks={lock?.locks ?? []}
					comments={comments ?? []}
					wakeups={queued?.wakeups ?? []}
					dispatch={queued?.dispatch}
				/>

				<div>
					<span className="text-text-subtle block mb-1 uppercase tracking-wider font-medium">
						Priority
					</span>
					<select
						value={task.priority}
						onChange={(e) => updateTask.mutate({ priority: e.target.value })}
						className="w-full rounded-radius-md border border-border bg-bg px-2.5 py-1.5 text-xs text-text outline-none"
					>
						{['low', 'medium', 'high', 'urgent'].map((p) => (
							<option key={p} value={p}>
								{p}
							</option>
						))}
					</select>
				</div>

				<div ref={assigneeRef} className="relative" data-testid="task-assignee">
					<span className="text-text-subtle block mb-1 uppercase tracking-wider font-medium">
						Assignee
					</span>
					{task.has_active_run ? (
						<div className="flex items-center gap-1 w-full text-[13px] text-text px-1 py-0.5">
							<AgentStatusLabel
								name={assignedAgent?.title ?? '—'}
								runtimeStatus={AgentRuntimeStatus.Active}
								className="flex-1 min-w-0"
							/>
							<InfoTooltip
								content="Cannot change assignee while an agent is running on this task"
								label="Assignee locked: agent is running"
							/>
						</div>
					) : (
						<>
							<button
								type="button"
								onClick={() => setAssigneeOpen((o) => !o)}
								className="flex items-center gap-1 w-full text-left text-[13px] text-text rounded-radius-md hover:bg-bg-subtle px-1 py-0.5 transition-colors"
							>
								<AgentStatusLabel
									name={assignedAgent?.title ?? '—'}
									runtimeStatus={AgentRuntimeStatus.Idle}
									className="flex-1 min-w-0"
								/>
								<ChevronDown
									className={`w-3.5 h-3.5 text-text-subtle shrink-0 transition-transform ${assigneeOpen ? 'rotate-180' : ''}`}
								/>
							</button>
							{assigneeOpen && (
								<div className="absolute left-0 right-0 top-full mt-1 z-20 rounded-radius-md border border-border bg-bg shadow-md max-h-48 overflow-y-auto">
									{assigneeOptions?.map((a) => (
										<button
											type="button"
											key={a.id}
											onClick={() => {
												updateTask.mutate({ assignee_id: a.id });
												setAssigneeOpen(false);
											}}
											className={`flex items-center w-full px-2.5 py-1.5 text-xs text-left hover:bg-bg-subtle transition-colors ${
												a.id === task.assignee_id ? 'bg-bg-subtle font-medium' : ''
											}`}
										>
											<AgentStatusLabel name={a.title} runtimeStatus={AgentRuntimeStatus.Idle} />
										</button>
									))}
								</div>
							)}
						</>
					)}
				</div>

				<div>
					<span className="text-text-subtle block mb-1 uppercase tracking-wider font-medium">
						Project
					</span>
					{task.project_name && task.project_slug ? (
						<Link
							to="/projects/$projectId"
							params={{ projectId: task.project_slug }}
							className="text-[13px] text-text hover:text-accent-blue-text transition-colors"
						>
							{task.project_name}
						</Link>
					) : (
						<span className="text-[13px] text-text">—</span>
					)}
				</div>

				<div>
					<span className="text-text-subtle block mb-1 uppercase tracking-wider font-medium">
						Created
					</span>
					<span className="text-[13px] text-text">
						{new Date(task.created_at).toLocaleDateString()}
					</span>
				</div>

				<div>
					<span className="text-text-subtle block mb-1 uppercase tracking-wider font-medium">
						Effort
					</span>
					<select
						value={commentEffort ?? effectiveDefaultEffort}
						onChange={(e) => setCommentEffort(e.target.value as AgentEffort)}
						className="w-full rounded-radius-md border border-border bg-bg px-2.5 py-1.5 text-xs text-text outline-none"
						aria-label="Reasoning effort for the agent run triggered by this comment"
					>
						{EFFORT_LEVELS.map(({ value, label }) => (
							<option key={value} value={value}>
								{label}
								{value === effectiveDefaultEffort ? ' (default)' : ''}
							</option>
						))}
					</select>
				</div>

				<div className="mt-auto pt-4 border-t border-border">
					{task.status === TaskStatus.Closed ? (
						<Button
							variant="secondary"
							size="sm"
							className="w-full"
							onClick={() => setReopenOpen(true)}
							data-testid="task-reopen-button"
						>
							Re-open task
						</Button>
					) : (
						<Button
							variant="danger-text"
							size="sm"
							className="w-full"
							onClick={() => setCloseOpen(true)}
							data-testid="task-close-button"
						>
							Close task
						</Button>
					)}
				</div>

				{!atBottom && (
					<button
						type="button"
						onClick={scrollToBottom}
						data-testid="task-scroll-to-bottom"
						aria-label="Scroll to bottom"
						className="fixed bottom-4 right-4 z-30 w-9 h-9 rounded-full border border-border bg-bg-elevated text-text-muted hover:text-text shadow-md flex items-center justify-center"
					>
						<ArrowDown className="w-4 h-4" />
					</button>
				)}
			</div>

			<ConfirmDialog
				open={closeOpen}
				onOpenChange={setCloseOpen}
				title="Close this task?"
				description="The task will be marked as closed. This skips the coach review step that runs when an task is marked done."
				confirmLabel="Close task"
				variant="danger"
				loading={updateTask.isPending}
				onConfirm={async () => {
					await updateTask.mutateAsync({ status: TaskStatus.Closed });
					scrollToBottom();
				}}
			/>

			<ConfirmDialog
				open={reopenOpen}
				onOpenChange={setReopenOpen}
				title="Re-open this task?"
				description="Status will be set back to backlog."
				confirmLabel="Re-open"
				loading={updateTask.isPending}
				onConfirm={async () => {
					await updateTask.mutateAsync({ status: TaskStatus.Backlog });
					scrollToBottom();
				}}
			/>
		</>
	);
}
