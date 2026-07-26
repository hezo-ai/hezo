import {
	AgentEffort,
	AgentRuntimeStatus,
	CAPTAIN_AGENT_SLUG,
	DEFAULT_EFFORT,
	HeartbeatRunStatus,
	HQ_PROJECT_SLUG,
	TaskPriority,
	TaskStatus,
	TERMINAL_TASK_STATUSES,
} from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Agent } from '../../hooks/use-agents';
import type { CommentSkeleton } from '../../hooks/use-comments';
import type { ExecutionLockState } from '../../hooks/use-execution-locks';
import { useQueuedWakeups } from '../../hooks/use-queued-wakeups';
import type { Task, useUpdateTask } from '../../hooks/use-tasks';
import { TASK_RUN_STATUS_META } from '../../lib/status-meta';
import { AgentLink } from '../agent-link';
import { AgentStatusLabel } from '../agent-status-label';
import { TaskStatusBadge } from '../task-status-badge';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { InfoTooltip } from '../ui/info-tooltip';
import { RelativeTime } from '../ui/relative-time';
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
	comments: CommentSkeleton[] | undefined;
	updateTask: ReturnType<typeof useUpdateTask>;
	commentEffort: AgentEffort | null;
	setCommentEffort: (v: AgentEffort | null) => void;
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
	const isInternalProject = task.project_slug === HQ_PROJECT_SLUG;
	const assigneeOptions = agents
		?.filter((a) => a.admin_status !== 'disabled')
		.filter((a) => !isInternalProject || a.slug === CAPTAIN_AGENT_SLUG);

	// Reassignment is blocked whenever the task carries any non-terminal run —
	// that mirrors the server, which 409s on a queued run just as it does on a
	// running one, and on any agent's run rather than only the assignee's. The
	// pill, though, labels *the assignee*, so it stays Idle unless the active run
	// is theirs, and distinguishes a run that is executing from one still waiting.
	const activeRun = task.active_run ?? null;
	const assigneeOwnsRun = activeRun !== null && activeRun.member_id === task.assignee_id;
	const assigneeRunBadge = assigneeOwnsRun ? TASK_RUN_STATUS_META[activeRun.status] : undefined;
	const assigneeLock = !activeRun
		? null
		: !assigneeOwnsRun
			? {
					content: 'Cannot change assignee while another agent has a run on this task',
					label: 'Assignee locked: another agent is running',
				}
			: activeRun.status === HeartbeatRunStatus.Queued
				? {
						content: `Cannot change assignee while a run is queued on this task${
							activeRun.queued_reason ? ` - ${activeRun.queued_reason}` : ''
						}`,
						label: 'Assignee locked: run queued',
					}
				: {
						content: 'Cannot change assignee while an agent is running on this task',
						label: 'Assignee locked: agent is running',
					};

	return (
		<>
			<div
				data-testid="task-sidebar"
				// Sticky offset = container-banner height (clears the sticky status banner
				// when present) + the project layout's lg:py-6 (1.5rem) padding. Mirroring
				// the padding keeps the breathing room above the sidebar when it sticks;
				// without it the sidebar slides flush against the app header on scroll.
				className="flex flex-col gap-4 text-xs lg:sticky lg:top-[calc(var(--container-banner-h,0px)_+_1.5rem)] lg:self-start"
			>
				<AgentQueueSection
					projectId={projectId}
					taskId={task.id}
					agents={agents}
					locks={lock?.locks ?? []}
					comments={comments ?? []}
					wakeups={queued?.wakeups ?? []}
					dispatch={queued?.dispatch}
				/>

				<div>
					<span className="text-text-3 block mb-1 uppercase tracking-wider font-medium">
						Status
					</span>
					<TaskStatusBadge status={task.status} testId="task-status" />
				</div>

				<div>
					<span className="text-text-3 block mb-1 uppercase tracking-wider font-medium">
						Priority
					</span>
					<select
						value={task.priority}
						onChange={(e) => updateTask.mutate({ priority: e.target.value })}
						className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-text-1 outline-none"
					>
						{[TaskPriority.Low, TaskPriority.Medium, TaskPriority.High, TaskPriority.Urgent].map(
							(p) => (
								<option key={p} value={p}>
									{p}
								</option>
							),
						)}
					</select>
				</div>

				<div ref={assigneeRef} className="relative" data-testid="task-assignee">
					<span className="text-text-3 block mb-1 uppercase tracking-wider font-medium">
						Assignee
					</span>
					{assigneeLock ? (
						<div className="flex items-center gap-1 w-full text-[13px] text-text-1 px-1 py-0.5">
							{assignedAgent ? (
								<AgentLink
									projectId={projectId}
									agentId={assignedAgent.slug}
									className="flex flex-1 min-w-0 items-center hover:text-info-soft-fg transition-colors"
									testId="task-assignee-link"
								>
									<AgentStatusLabel
										name={assignedAgent.title}
										runtimeStatus={AgentRuntimeStatus.Idle}
										badge={assigneeRunBadge}
										className="min-w-0"
									/>
								</AgentLink>
							) : (
								<AgentStatusLabel
									name="—"
									runtimeStatus={AgentRuntimeStatus.Idle}
									badge={assigneeRunBadge}
									className="flex-1 min-w-0"
								/>
							)}
							<InfoTooltip content={assigneeLock.content} label={assigneeLock.label} />
						</div>
					) : (
						<>
							<div className="flex items-center gap-1 w-full text-[13px] text-text-1 px-1 py-0.5">
								{assignedAgent ? (
									<AgentLink
										projectId={projectId}
										agentId={assignedAgent.slug}
										className="flex flex-1 min-w-0 items-center hover:text-info-soft-fg transition-colors"
										testId="task-assignee-link"
									>
										<AgentStatusLabel
											name={assignedAgent.title}
											runtimeStatus={AgentRuntimeStatus.Idle}
											className="min-w-0"
										/>
									</AgentLink>
								) : (
									<span className="flex flex-1 min-w-0 items-center">
										<AgentStatusLabel
											name="—"
											runtimeStatus={AgentRuntimeStatus.Idle}
											className="min-w-0"
										/>
									</span>
								)}
								<button
									type="button"
									onClick={() => setAssigneeOpen((o) => !o)}
									aria-label="Change assignee"
									className="shrink-0 rounded-md hover:bg-surface-2 p-1 transition-colors"
								>
									<ChevronDown
										className={`w-3.5 h-3.5 text-text-3 transition-transform ${assigneeOpen ? 'rotate-180' : ''}`}
									/>
								</button>
							</div>
							{assigneeOpen && (
								<div className="absolute left-0 right-0 top-full mt-1 z-20 rounded-md border border-border bg-surface shadow-md max-h-48 overflow-y-auto">
									{assigneeOptions?.map((a) => (
										<button
											type="button"
											key={a.id}
											onClick={() => {
												updateTask.mutate({ assignee_id: a.id });
												setAssigneeOpen(false);
											}}
											className={`flex items-center w-full px-2.5 py-1.5 text-xs text-left hover:bg-surface-2 transition-colors ${
												a.id === task.assignee_id ? 'bg-surface-2 font-medium' : ''
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
					<span className="text-text-3 block mb-1 uppercase tracking-wider font-medium">
						Project
					</span>
					{task.project_name && task.project_slug ? (
						<Link
							to="/projects/$projectId"
							params={{ projectId: task.project_slug }}
							className="text-[13px] text-text-1 hover:text-info-soft-fg transition-colors"
						>
							{task.project_name}
						</Link>
					) : (
						<span className="text-[13px] text-text-1">—</span>
					)}
				</div>

				<div>
					<span className="text-text-3 block mb-1 uppercase tracking-wider font-medium">
						Created
					</span>
					<RelativeTime iso={task.created_at} className="text-[13px] text-text-1" />
				</div>

				<div>
					<span className="text-text-3 block mb-1 uppercase tracking-wider font-medium">
						Effort
					</span>
					<select
						value={commentEffort ?? effectiveDefaultEffort}
						onChange={(e) => setCommentEffort(e.target.value as AgentEffort)}
						className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-text-1 outline-none"
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

				<div className="mt-auto pt-4 border-t border-border space-y-2">
					{(TERMINAL_TASK_STATUSES as readonly string[]).includes(task.status) && (
						<Button
							variant="secondary"
							size="sm"
							className="w-full"
							onClick={() => setReopenOpen(true)}
							data-testid="task-reopen-button"
						>
							Re-open task
						</Button>
					)}
					{!(TERMINAL_TASK_STATUSES as readonly string[]).includes(task.status) && (
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
			</div>

			<ConfirmDialog
				open={closeOpen}
				onOpenChange={setCloseOpen}
				title="Close this task?"
				description="The task will be marked as cancelled. Use this for work that's being abandoned rather than completed."
				confirmLabel="Close task"
				variant="danger"
				loading={updateTask.isPending}
				onConfirm={async () => {
					await updateTask.mutateAsync({ status: TaskStatus.Cancelled });
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
