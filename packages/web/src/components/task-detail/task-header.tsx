import { Link } from '@tanstack/react-router';
import { Check, ChevronRight, Loader2, Pencil, X } from 'lucide-react';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { useAgentLookup } from '../../hooks/use-agent-lookup';
import { type Task, useTaskAncestors, type useUpdateTask } from '../../hooks/use-tasks';
import { formatDuration } from '../../lib/format-duration';
import { useI18n } from '../../lib/i18n';
import { AgentRef } from '../agent-ref';
import { MarkdownProse } from '../markdown-prose';
import { TaskPriorityBadge } from '../task-priority-badge';
import { TaskStatusBadge } from '../task-status-badge';
import { Badge } from '../ui/badge';
import { Tooltip } from '../ui/tooltip';
import { MarkdownFieldEditor } from './markdown-field-editor';

type UpdateTaskMutation = ReturnType<typeof useUpdateTask>;

interface TaskHeaderProps {
	task: Task;
	projectId: string;
	taskId: string;
	taskProjectSlug: string;
	updateTask: UpdateTaskMutation;
}

/**
 * True once the element behind `ref` has scrolled out of the top of the shell
 * scroller - which, for the sentinel marking the breadcrumb's resting place,
 * means the pinned breadcrumb is now covering content rather than sitting in
 * the page flow.
 *
 * Reading the breadcrumb's own rect on every scroll event would force a layout
 * flush per frame on a thread that runs to hundreds of comments, so this asks
 * the question with one IntersectionObserver over a zero-height sentinel.
 */
function useScrolledPast(ref: RefObject<HTMLElement | null>): boolean {
	const [scrolledPast, setScrolledPast] = useState(false);
	useEffect(() => {
		// The component-test harness stubs IntersectionObserver to a no-op, so the
		// crumb keeps its resting look there; the browser spec covers the pinning.
		if (typeof IntersectionObserver === 'undefined') return;
		const el = ref.current;
		if (!el) return;
		// <main> is the scroll container - the window never scrolls (see __root.tsx).
		const io = new IntersectionObserver(
			([entry]) => setScrolledPast(entry ? !entry.isIntersecting : false),
			{ root: document.querySelector('main') },
		);
		io.observe(el);
		return () => io.disconnect();
	}, [ref]);
	return scrolledPast;
}

/**
 * Top-of-page header for a task: a breadcrumb of ancestor tasks ending in the
 * current identifier - pinned to the top of the shell scroller at `lg`+, so a
 * long thread never leaves the reader without the task's identity or a way back
 * to the list - then the title, an inline mono metadata row (status ·
 * priority · assignee) with a runs · duration · cost summary, the queued-wakeup
 * chip, and the description card. The title renames in place and the description
 * edits in place; both are recorded on the task thread as meta comments by the
 * server. Nothing status-mutating lives here — assignee / close / reopen are in
 * the sidebar.
 */
export function TaskHeader({
	task,
	projectId,
	taskId,
	taskProjectSlug,
	updateTask,
}: TaskHeaderProps) {
	// Ancestors come back root-first, excluding the current task, so the
	// breadcrumb reads `Tasks → root → … → parent → current`. Sub-tasks are
	// capped at three levels deep, so at most three ancestor links precede the
	// current identifier. They share the current task's project (sub-tasks
	// inherit the parent's project), so the current task's slug is the right
	// link target — for the task-list crumb too.
	const { data: ancestors } = useTaskAncestors(projectId, taskId);
	// The badge showed the raw role slug; resolve the assignee so it reads the
	// same label as every other surface, and carries the identity card.
	const { byMemberId: agentsByMemberId } = useAgentLookup(projectId);
	const assigneeAgent = task.assignee_id ? agentsByMemberId.get(task.assignee_id) : undefined;
	const { t } = useI18n();
	const [editingDescription, setEditingDescription] = useState(false);
	// Drives the pinned crumb's hairline: absent at rest so the page keeps its
	// clean top edge, drawn once content is passing underneath.
	const restingSentinelRef = useRef<HTMLDivElement>(null);
	const pinned = useScrolledPast(restingSentinelRef);
	return (
		<>
			{/* Marks where the breadcrumb rests. `-mb-px` keeps it out of the layout. */}
			<div ref={restingSentinelRef} aria-hidden="true" className="h-px w-full -mb-px" />
			{/* Desktop pins the crumb to the top of the scrolling <main>; below `lg` it
			    scrolls away with the rest, where vertical space is the scarce thing.
			    `top` clears the project banners stickied above it in the same scroller,
			    reading the height ContainerStatusBanner publishes - the idiom the task
			    meta rail already uses. z-10 stays under those banners (z-20 and up) and
			    over the content column, which carries no z-index of its own. */}
			<nav
				aria-label="Breadcrumb"
				data-pinned={pinned ? 'true' : 'false'}
				className={`mb-1 flex flex-wrap items-center gap-x-1 text-[13px] font-mono text-text-2 lg:sticky lg:top-[var(--container-banner-h,0px)] lg:z-10 lg:-mt-3 lg:mb-0 lg:border-b lg:border-transparent lg:bg-bg lg:pt-3 lg:pb-2 lg:transition-[border-color,box-shadow] lg:duration-150 ${
					pinned ? 'lg:border-border lg:shadow-xs' : ''
				}`}
				data-testid="task-breadcrumb"
			>
				<span className="flex items-center gap-x-1">
					<Link
						to="/projects/$projectId/tasks"
						params={{ projectId: taskProjectSlug }}
						className="hover:text-text-1 hover:underline transition-colors"
						data-testid="task-breadcrumb-tasks"
					>
						Tasks
					</Link>
					<ChevronRight className="w-3 h-3 shrink-0 text-text-3" />
				</span>
				{ancestors?.map((ancestor) => (
					<span key={ancestor.id} className="flex items-center gap-x-1">
						<Link
							to="/projects/$projectId/tasks/$taskId"
							params={{ projectId: taskProjectSlug, taskId: ancestor.identifier.toLowerCase() }}
							className="hover:text-text-1 hover:underline transition-colors"
							title={ancestor.title}
							data-testid="task-breadcrumb-ancestor"
						>
							{ancestor.identifier}
						</Link>
						<ChevronRight className="w-3 h-3 shrink-0 text-text-3" />
					</span>
				))}
				<span aria-current="page">{task.identifier}</span>
			</nav>
			<TaskTitle task={task} updateTask={updateTask} />

			{/* Wire spec - status / priority / assignee render as quiet-tint badges
			    (treatment A, the default), color-coding state at a glance the same way
			    the task list does, with a mono runs / duration / cost summary pushed
			    right. Assignee carries no semantic state, so it stays neutral. */}
			<div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1.5">
				<TaskStatusBadge status={task.status} testId="task-status-inline" />
				<TaskPriorityBadge priority={task.priority} testId="task-priority-inline" />
				{task.assignee_id && (
					<Badge color="neutral" className="max-w-[12rem]" testId="task-assignee-inline">
						<AgentRef
							agent={assigneeAgent}
							fallbackName={task.assignee_name ?? task.assignee_slug ?? undefined}
							className="truncate"
						/>
					</Badge>
				)}
				{!task.has_active_run && task.queued_wakeup && (
					<Badge color="blue" className="gap-1" testId="task-queued-badge">
						<span className="inline-block w-1.5 h-1.5 rounded-full bg-info-soft-fg" />
						{task.queued_wakeup.reason === 'instance_at_capacity' ||
						task.queued_wakeup.reason === 'project_at_capacity'
							? 'Queued - at the container limit'
							: 'Run queued'}
					</Badge>
				)}
				{task.run_count > 0 && (
					<span
						className="font-mono text-[13px] text-text-3 sm:ml-auto"
						data-testid="task-run-summary"
					>
						{task.run_count} {task.run_count === 1 ? 'run' : 'runs'}
						{task.total_duration_seconds > 0 && ` · ${formatDuration(task.total_duration_seconds)}`}
						{task.total_cost_cents > 0 && ` · $${(task.total_cost_cents / 100).toFixed(2)}`}
					</span>
				)}
			</div>

			{/* Always rendered, even with no description - the empty card is the only
			    affordance for adding one. */}
			<div
				className="mb-5 rounded-md border border-border bg-surface overflow-hidden"
				data-testid="task-description-card"
			>
				<div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border bg-surface-3">
					<span className="text-xs font-medium text-text-2">Description</span>
					{!editingDescription && (
						<button
							type="button"
							onClick={() => setEditingDescription(true)}
							data-testid="task-description-edit"
							className="text-[11px] text-text-3 hover:text-text-1"
						>
							{t('common.edit')}
						</button>
					)}
				</div>
				<div className="px-3 py-2.5">
					{editingDescription ? (
						<MarkdownFieldEditor
							ariaLabel="Description"
							projectId={projectId}
							projectSlug={taskProjectSlug}
							value={task.description}
							className="min-h-[96px]"
							previewClassName="min-h-[96px]"
							// Cleared to '' rather than null: `description` is a plain text
							// column and both write surfaces type it as a string, so '' is the
							// one "no description" value they share.
							onSave={(next) => updateTask.mutate({ description: next ?? '' })}
							onClose={() => setEditingDescription(false)}
						/>
					) : task.description ? (
						<MarkdownProse
							testId="task-description"
							projectId={projectId}
							projectSlug={taskProjectSlug}
						>
							{task.description}
						</MarkdownProse>
					) : (
						<span className="text-[13px] text-text-3" data-testid="task-description-empty">
							{t('tasks.description.empty')}
						</span>
					)}
				</div>
			</div>
		</>
	);
}

/**
 * The task title, renamed in place. Copies the single-line rename pattern from
 * `ProviderNameCell` (ai-providers-section.tsx): pencil to open, Enter to save,
 * Escape to cancel, and the editor stays open on failure so the typed name is not
 * lost (the mutation hook toasts the error on rollback).
 */
function TaskTitle({ task, updateTask }: { task: Task; updateTask: UpdateTaskMutation }) {
	const { t } = useI18n();
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState(task.title);

	function cancel() {
		setEditing(false);
		setValue(task.title);
	}

	async function submit() {
		const trimmed = value.trim();
		// An empty or unchanged title is a cancel, not a request: the server writes
		// `title` verbatim, so submitting '' would leave the task without a name.
		if (!trimmed || trimmed === task.title) {
			cancel();
			return;
		}
		try {
			await updateTask.mutateAsync({ title: trimmed });
			setEditing(false);
		} catch {
			// Left open on purpose — `useUpdateTask` has already toasted and rolled back.
		}
	}

	if (!editing) {
		return (
			<div className="mb-3 flex items-start gap-1.5">
				<h1 className="min-w-0 break-words text-xl font-medium" data-testid="task-title">
					{task.title}
				</h1>
				<Tooltip content={t('tasks.renameTask')}>
					<button
						type="button"
						onClick={() => {
							setValue(task.title);
							setEditing(true);
						}}
						aria-label={t('tasks.renameTask')}
						data-testid="task-title-edit"
						className="shrink-0 mt-1 p-1 text-text-3 hover:text-text-1"
					>
						<Pencil className="w-3.5 h-3.5" />
					</button>
				</Tooltip>
			</div>
		);
	}

	return (
		<div className="mb-3 flex items-start gap-1.5">
			<input
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						submit();
					}
					if (e.key === 'Escape') cancel();
				}}
				aria-label={t('tasks.renameTask')}
				// biome-ignore lint/a11y/noAutofocus: the user just clicked the edit icon — focus follows their action
				autoFocus
				disabled={updateTask.isPending}
				data-testid="task-title-input"
				className="min-w-0 flex-1 rounded-md border border-border bg-surface-2 px-2 py-1 text-xl font-medium text-text-1 outline-none focus:border-border-strong disabled:opacity-50"
			/>
			<Tooltip content={t('common.save')}>
				<button
					type="button"
					onClick={submit}
					aria-label={t('common.save')}
					disabled={updateTask.isPending}
					data-testid="task-title-save"
					className="shrink-0 mt-1.5 text-text-3 hover:text-text-1 disabled:opacity-50"
				>
					{updateTask.isPending ? (
						<Loader2 className="w-3.5 h-3.5 animate-spin" />
					) : (
						<Check className="w-3.5 h-3.5" />
					)}
				</button>
			</Tooltip>
			<Tooltip content={t('common.cancel')}>
				<button
					type="button"
					onClick={cancel}
					aria-label={t('common.cancel')}
					disabled={updateTask.isPending}
					data-testid="task-title-cancel"
					className="shrink-0 mt-1.5 text-text-3 hover:text-text-1 disabled:opacity-50"
				>
					<X className="w-3.5 h-3.5" />
				</button>
			</Tooltip>
		</div>
	);
}
