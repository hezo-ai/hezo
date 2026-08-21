import { Link } from '@tanstack/react-router';
import { Check, ChevronRight, Loader2, Pencil, X } from 'lucide-react';
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAgentLookup } from '../../hooks/use-agent-lookup';
import { type Task, useTaskAncestors, type useUpdateTask } from '../../hooks/use-tasks';
import { formatDuration } from '../../lib/format-duration';
import { useI18n } from '../../lib/i18n';
import { AgentRef } from '../agent-ref';
import { MarkdownProse } from '../markdown-prose';
import { TaskPriorityBadge } from '../task-priority-badge';
import { TaskStatusBadge } from '../task-status-badge';
import { Badge } from '../ui/badge';
import { BreadcrumbRow } from '../ui/breadcrumb';
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
 * `topOffsetPx` shrinks the top of the scrollport by whatever is pinned over it,
 * so "out of the top" means "out of sight" rather than "past the scrollport
 * edge". The title sentinel needs it: the crumb band hides the heading a band's
 * height before the heading actually leaves, and without the offset there is a
 * stretch of scroll where neither the heading nor the crumb carries the name.
 *
 * Reading the breadcrumb's own rect on every scroll event would force a layout
 * flush per frame on a thread that runs to hundreds of comments, so this asks
 * the question with one IntersectionObserver over a zero-height sentinel.
 */
function useScrolledPast(ref: RefObject<HTMLElement | null>, topOffsetPx = 0): boolean {
	const [scrolledPast, setScrolledPast] = useState(false);
	useEffect(() => {
		// The component-test harness stubs IntersectionObserver to report the target
		// as intersecting, so the crumb keeps its resting look there - no hairline,
		// no name. The browser spec covers both transitions.
		if (typeof IntersectionObserver === 'undefined') return;
		const el = ref.current;
		if (!el) return;
		// <main> is the scroll container - the window never scrolls (see __root.tsx).
		const io = new IntersectionObserver(
			([entry]) => setScrolledPast(entry ? !entry.isIntersecting : false),
			{ root: document.querySelector('main'), rootMargin: `-${topOffsetPx}px 0px 0px 0px` },
		);
		io.observe(el);
		return () => io.disconnect();
	}, [ref, topOffsetPx]);
	return scrolledPast;
}

/**
 * Height of everything pinned over the top of the shell scroller on this page:
 * the project banners the crumb clears (published as `--container-banner-h`) plus
 * the crumb's own band. That is the strip of `<main>` a reader cannot see into,
 * and so the offset the title sentinel is judged against.
 */
function usePinnedBandHeight(navRef: RefObject<HTMLElement | null>, pinned: boolean): number {
	const [band, setBand] = useState(0);
	useLayoutEffect(() => {
		// Only measurable while the crumb is actually pinned - that is when its own
		// bottom edge marks the bottom of the strip. Taking it from the crumb's rect
		// rather than adding up `--container-banner-h` and a height keeps the two
		// halves in step: whatever ends up stacked above the crumb is already
		// counted, because the crumb sits below it.
		if (!pinned) return;
		const el = navRef.current;
		const main = document.querySelector('main');
		if (!el || !main) return;
		const measure = () => {
			const next = Math.round(el.getBoundingClientRect().bottom - main.getBoundingClientRect().top);
			// Only ever set a changed value: this feeds an effect dependency, and a
			// fresh number every measurement would rebuild the observer in a loop.
			setBand((prev) => (prev === next ? prev : next));
		};
		measure();
		if (typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		ro.observe(main);
		return () => ro.disconnect();
	}, [navRef, pinned]);
	return band;
}

/**
 * Top-of-page header for a task: a breadcrumb of ancestor tasks ending in the
 * current identifier - pinned to the top of the shell scroller at every
 * breakpoint, so a long thread never leaves the reader without the task's
 * identity or a way back to the list, and taking on the task's name once the
 * heading below has scrolled out of sight - then the title, an inline mono
 * metadata row (status ·
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
	// Drives the handoff of the task's name from the heading to the crumb. The
	// sentinel sits under the heading rather than on it, because TaskTitle swaps
	// the <h1> for an <input> mid-rename and an observer on the heading would let
	// go of the name for as long as the field is open.
	const navRef = useRef<HTMLElement>(null);
	const titleSentinelRef = useRef<HTMLDivElement>(null);
	const band = usePinnedBandHeight(navRef, pinned);
	const titleHidden = useScrolledPast(titleSentinelRef, band);
	return (
		<>
			{/* Marks where the breadcrumb rests. `-mb-px` keeps it out of the layout. */}
			<div ref={restingSentinelRef} aria-hidden="true" className="h-px w-full -mb-px" />
			{/* Pinned to the top of the scrolling <main> at every breakpoint - the phone
			    is where the title leaves the screen soonest, so it is the last place to
			    drop the crumb. `top` clears the project banners stickied above it in the
			    same scroller, reading the height ContainerStatusBanner publishes - the
			    idiom the task meta rail already uses. z-10 stays under those banners
			    (z-20 and up) and over the content column, which carries no z-index of
			    its own. `-mt-3` cancels the `pt-3` that gives the pinned band its top
			    breathing room, so the resting position is unmoved; the route wrapper
			    always leaves at least that much above (py-4 at its narrowest).

			    One line at every width: nothing here gives way, and BreadcrumbRow scrolls
			    the overflow sideways instead, so a deep sub-task's whole chain stays
			    reachable on the narrowest phone. */}
			<BreadcrumbRow
				ref={navRef}
				data-pinned={pinned ? 'true' : 'false'}
				className={`sticky top-[var(--container-banner-h,0px)] z-10 -mt-3 border-b border-transparent bg-bg pt-3 pb-2 text-[13px] font-mono text-text-2 transition-[border-color,box-shadow] duration-150 ${
					pinned ? 'border-border shadow-xs' : ''
				}`}
				data-testid="task-breadcrumb"
			>
				<span className="flex shrink-0 items-center gap-x-1 whitespace-nowrap">
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
					<span key={ancestor.id} className="flex shrink-0 items-center gap-x-1 whitespace-nowrap">
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
				{/* Identifier and name are one crumb, so they sit inside a single
				    `aria-current` - a reader hears "HM-246, Fix the flaky test", not two
				    separate items. The name is sans against the mono identifiers because it
				    is prose, not something you quote.

				    It joins the crumb only once the heading carrying it has gone under the
				    band: while both are on screen the crumb would just be saying the title
				    twice, and the identifier alone leaves the row short enough to read at a
				    glance. */}
				<span aria-current="page" className="flex shrink-0 items-center gap-x-1">
					<span className="whitespace-nowrap">{task.identifier}</span>
					{titleHidden && (
						<>
							<span aria-hidden="true" className="shrink-0 text-text-3">
								·
							</span>
							<span
								className="whitespace-nowrap font-sans text-text-3"
								title={task.title}
								data-testid="task-breadcrumb-title"
							>
								{task.title}
							</span>
						</>
					)}
				</span>
			</BreadcrumbRow>
			<TaskTitle task={task} updateTask={updateTask} />
			{/* Marks the foot of the heading: once this is under the pinned band, the
			    name has left the page and the crumb picks it up. `-mb-px` keeps it out
			    of the layout. */}
			<div ref={titleSentinelRef} aria-hidden="true" className="h-px w-full -mb-px" />

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
