import {
	AgentEffort,
	AgentRuntimeStatus,
	CAPTAIN_AGENT_SLUG,
	DEFAULT_EFFORT,
	INTERNAL_PROJECT_SLUG,
	TaskStatus,
} from '@hezo/shared';
import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { ArrowDown, ChevronDown, Loader2 } from 'lucide-react';
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Task } from '../../../../../../hooks/use-tasks';
import { api } from '../../../../../../lib/api';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

import { AgentStatusLabel } from '../../../../../../components/agent-status-label';
import { CommentComposer } from '../../../../../../components/task-detail/comment-composer';
import {
	CommentsSection,
	jumpToComment,
} from '../../../../../../components/task-detail/comments-section';
import { DependenciesSection } from '../../../../../../components/task-detail/dependencies-section';
import { SubTasksSection } from '../../../../../../components/task-detail/sub-tasks-section';
import { TaskHeader } from '../../../../../../components/task-detail/task-header';
import { TaskSummary } from '../../../../../../components/task-detail/task-summary';
import { Button } from '../../../../../../components/ui/button';
import { ConfirmDialog } from '../../../../../../components/ui/confirm-dialog';
import { InfoTooltip } from '../../../../../../components/ui/info-tooltip';
import { useAgents } from '../../../../../../hooks/use-agents';
import { type Comment, useComments, useCreateComment } from '../../../../../../hooks/use-comments';
import { type ExecutionLock, useExecutionLock } from '../../../../../../hooks/use-execution-locks';
import { useTask, useUpdateTask } from '../../../../../../hooks/use-tasks';

const EFFORT_LEVELS: { value: AgentEffort; label: string }[] = [
	{ value: AgentEffort.Minimal, label: 'Minimal' },
	{ value: AgentEffort.Low, label: 'Low' },
	{ value: AgentEffort.Medium, label: 'Medium' },
	{ value: AgentEffort.High, label: 'High' },
	{ value: AgentEffort.Max, label: 'Max (ultrathink)' },
];

function TaskDetailPage() {
	const { teamId, projectId, taskId } = Route.useParams();
	const { data: task, isLoading } = useTask(teamId, taskId);

	const { data: comments } = useComments(teamId, taskId);
	const { data: agents } = useAgents(teamId);
	const { data: lock } = useExecutionLock(teamId, taskId);
	const updateTask = useUpdateTask(teamId, taskId);
	const createComment = useCreateComment(teamId, taskId);
	// Per-comment reasoning effort. `null` = user hasn't touched the dropdown, so
	// leave effort unset on submit and let the server resolve the agent default.
	const [commentEffort, setCommentEffort] = useState<AgentEffort | null>(null);
	const [replyTarget, setReplyTarget] = useState<Comment | null>(null);
	const commentFormRef = useRef<HTMLFormElement>(null);
	const commentTextareaRef = useRef<HTMLTextAreaElement>(null);
	const [assigneeOpen, setAssigneeOpen] = useState(false);
	const [closeOpen, setCloseOpen] = useState(false);
	const [reopenOpen, setReopenOpen] = useState(false);
	const assigneeRef = useRef<HTMLDivElement>(null);
	// The app shell wraps the route in `<main className="flex-1 overflow-auto">`
	// (see __root.tsx). The window never scrolls — that <main> does — so
	// Virtuoso needs `customScrollParent` pointing at it for measurement and
	// scroll restoration to work. Resolve before paint so Virtuoso's first
	// mount is wired to the right scroll container.
	const [scrollParent, setScrollParent] = useState<HTMLElement | null>(null);
	useLayoutEffect(() => {
		if (typeof document === 'undefined') return;
		setScrollParent(document.querySelector('main'));
	}, []);

	const [atBottom, setAtBottom] = useState(false);
	useEffect(() => {
		if (!scrollParent) return;
		const check = () => {
			setAtBottom(
				scrollParent.scrollTop + scrollParent.clientHeight >= scrollParent.scrollHeight - 200,
			);
		};
		check();
		scrollParent.addEventListener('scroll', check, { passive: true });
		const ro = new ResizeObserver(check);
		ro.observe(scrollParent);
		for (const child of Array.from(scrollParent.children)) ro.observe(child);
		return () => {
			scrollParent.removeEventListener('scroll', check);
			ro.disconnect();
		};
	}, [scrollParent]);

	const scrollToBottom = () => {
		if (!scrollParent) return;
		const target = scrollParent;
		target.scrollTo({ top: target.scrollHeight, behavior: 'smooth' });
		// Lazy virtualised content keeps growing scrollHeight as new rows render,
		// so re-anchor at the bottom until the height stops changing or the budget runs out.
		const deadline = Date.now() + 5000;
		let lastScrollHeight = -1;
		let stableTicks = 0;
		const tick = () => {
			target.scrollTo({ top: target.scrollHeight, behavior: 'auto' });
			if (target.scrollHeight === lastScrollHeight) {
				stableTicks++;
				if (stableTicks >= 3) return;
			} else {
				lastScrollHeight = target.scrollHeight;
				stableTicks = 0;
			}
			if (Date.now() >= deadline) return;
			setTimeout(tick, 100);
		};
		setTimeout(tick, 400);
	};

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

	const assignedAgent = agents?.find((a) => a.id === task?.assignee_id);
	const effectiveDefaultEffort: AgentEffort =
		assignedAgent?.slug === CAPTAIN_AGENT_SLUG
			? AgentEffort.Max
			: (assignedAgent?.default_effort ?? DEFAULT_EFFORT);
	const isInternalProject = task?.project_slug === INTERNAL_PROJECT_SLUG;
	const assigneeOptions = agents
		?.filter((a) => a.admin_status !== 'disabled')
		.filter((a) => !isInternalProject || a.slug === CAPTAIN_AGENT_SLUG);

	if (isLoading || !task)
		return <div className="text-text-muted text-[13px] py-8 text-center">Loading...</div>;

	function startReply(c: Comment) {
		setReplyTarget(c);
		requestAnimationFrame(() => {
			commentFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
			commentTextareaRef.current?.focus();
		});
	}

	const taskProjectSlug = task.project_slug ?? projectId;

	return (
		<div className="grid grid-cols-1 lg:grid-cols-[1fr_190px] gap-5">
			{/* Main content */}
			<div className="min-w-0">
				<TaskHeader task={task} teamId={teamId} taskProjectSlug={taskProjectSlug} />

				<TaskSummary
					task={task}
					teamId={teamId}
					taskProjectSlug={taskProjectSlug}
					updateTask={updateTask}
				/>

				<SubTasksSection
					teamId={teamId}
					taskId={taskId}
					parentTaskId={task.id}
					taskProjectSlug={taskProjectSlug}
				/>

				<DependenciesSection teamId={teamId} taskId={taskId} />

				{/* Comments */}
				<div className="border-t border-border pt-4">
					<div className="flex items-center gap-1.5 mb-4">
						<h3 className="text-[13px] text-text font-medium">Comments</h3>
						<span className="bg-bg-subtle px-[7px] py-px rounded-full text-[11px] text-text-muted">
							{comments?.length ?? 0}
						</span>
					</div>

					<CommentsSection
						task={task}
						teamId={teamId}
						taskId={taskId}
						taskProjectSlug={taskProjectSlug}
						scrollParent={scrollParent}
						onStartReply={startReply}
					/>

					<CommentComposer
						task={task}
						teamId={teamId}
						taskId={taskId}
						taskProjectSlug={taskProjectSlug}
						comments={comments}
						createComment={createComment}
						commentEffort={commentEffort}
						setCommentEffort={setCommentEffort}
						replyTarget={replyTarget}
						setReplyTarget={setReplyTarget}
						jumpToComment={jumpToComment}
						commentFormRef={commentFormRef}
						commentTextareaRef={commentTextareaRef}
					/>
				</div>
			</div>

			{/* Sidebar */}
			<div
				data-testid="task-sidebar"
				className="flex flex-col gap-4 text-xs lg:sticky lg:top-0 lg:self-start"
			>
				{lock && lock.locks.length > 0 && (
					<RunningAgentsLine locks={lock.locks} comments={comments ?? []} />
				)}

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
							to="/teams/$teamId/projects/$projectId"
							params={{ teamId, projectId: task.project_slug }}
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
		</div>
	);
}

type RunCommentRef = { id: string; content_type: string; content: unknown };

function RunningAgentsLine({
	locks,
	comments,
}: {
	locks: ExecutionLock[];
	comments: RunCommentRef[];
}) {
	const runCommentIdByAgentId = new Map<string, string>();
	for (const c of comments) {
		if (c.content_type !== 'run') continue;
		const agentId =
			c.content && typeof c.content === 'object'
				? (c.content as { agent_id?: string }).agent_id
				: undefined;
		if (agentId) runCommentIdByAgentId.set(agentId, c.id);
	}

	const ordered = [...locks].sort((a, b) => a.locked_at.localeCompare(b.locked_at));

	const nameNodes = ordered.map((l) => {
		const commentId = runCommentIdByAgentId.get(l.member_id);
		if (!commentId) {
			return (
				<span key={l.id} className="text-accent-blue-text font-medium">
					{l.member_name}
				</span>
			);
		}
		const targetId = `comment-${commentId}`;
		return (
			<a
				key={l.id}
				href={`#${targetId}`}
				onClick={(e) => {
					// Drive scroll via the hash so the task page's hashchange handler
					// can ask Virtuoso to mount and scroll to the row even when it
					// isn't currently in the DOM. Falling back to scrollIntoView
					// alone silently fails for off-screen virtualized rows.
					e.preventDefault();
					const next = `#${targetId}`;
					if (window.location.hash === next) {
						window.dispatchEvent(new HashChangeEvent('hashchange'));
					} else {
						window.history.pushState(null, '', next);
						window.dispatchEvent(new HashChangeEvent('hashchange'));
					}
				}}
				className="text-accent-blue-text font-medium hover:underline"
			>
				{l.member_name}
			</a>
		);
	});

	const parts: { key: string; node: React.ReactNode }[] = [];
	for (let i = 0; i < ordered.length; i++) {
		if (i > 0) {
			const isLastGap = i === ordered.length - 1;
			const sep = ordered.length === 2 ? ' and ' : isLastGap ? ', and ' : ', ';
			parts.push({ key: `sep-${ordered[i].id}`, node: sep });
		}
		parts.push({ key: `name-${ordered[i].id}`, node: nameNodes[i] });
	}

	const verb = ordered.length === 1 ? 'is' : 'are';

	return (
		<div
			className="rounded-radius-md bg-accent-blue-bg px-3 py-2 text-xs"
			data-testid="running-agents-line"
		>
			<span className="inline-block w-2 h-2 rounded-full bg-accent-blue animate-pulse mr-1.5 align-middle" />
			{parts.map((p) => (
				<Fragment key={p.key}>{p.node}</Fragment>
			))}{' '}
			<span className="text-text-muted">{verb} running</span>
		</div>
	);
}

export const Route = createFileRoute('/teams/$teamId/projects/$projectId/tasks/$taskId')({
	// Canonicalize the URL before the page renders so the route never paints
	// with the UUID form or a stale project slug. Previously a useEffect on
	// `task?.identifier` / `task?.project_slug` called `navigate({ replace })`
	// after the first paint, producing a one-frame flash of the wrong URL.
	// Priming via `ensureQueryData` keeps the page's later `useTask(...)` call
	// reading from cache so we don't double-fetch.
	beforeLoad: async ({ params, context }) => {
		const { teamId, projectId, taskId } = params;
		// Only redirect when the param IS a UUID or the project slug doesn't
		// match — never for any other non-canonical taskId. A stale friendly
		// identifier would still match a server lookup but isn't worth a hop.
		const isUuid = UUID_RE.test(taskId);
		let task: Task;
		try {
			task = await context.queryClient.ensureQueryData({
				queryKey: ['teams', teamId, 'tasks', taskId],
				queryFn: () => api.get<Task>(`/api/teams/${teamId}/tasks/${taskId}`),
			});
		} catch {
			// 404 / auth error — let the component render its loading/empty state
			// and surface the error through the normal query path.
			return;
		}
		const friendlyId = task.identifier.toLowerCase();
		const canonicalProject = task.project_slug ?? projectId;
		const needsIdNormalization = isUuid && taskId !== friendlyId;
		const needsProjectNormalization = projectId !== canonicalProject;
		if (needsIdNormalization || needsProjectNormalization) {
			// Prime the cache under the canonical key so the redirected route's
			// useTask call hits the cache directly without an extra round-trip.
			context.queryClient.setQueryData(['teams', teamId, 'tasks', friendlyId], task);
			throw redirect({
				to: '/teams/$teamId/projects/$projectId/tasks/$taskId',
				params: { teamId, projectId: canonicalProject, taskId: friendlyId },
				replace: true,
			});
		}
	},
	component: TaskDetailPage,
});
