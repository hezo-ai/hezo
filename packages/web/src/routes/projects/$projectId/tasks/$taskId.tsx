import { type AgentEffort, DEFAULT_TASK_VIEW, type TaskView } from '@hezo/shared';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { jumpToComment } from '../../../../components/comment-renderers';
import { CommentComposer } from '../../../../components/task-detail/comment-composer';
import { CommentsSection } from '../../../../components/task-detail/comments-section';
import { DependenciesSection } from '../../../../components/task-detail/dependencies-section';
import { LastRunFailedBanner } from '../../../../components/task-detail/last-run-failed-banner';
import {
	type PreviewItem,
	PreviewProvider,
} from '../../../../components/task-detail/preview-context';
import { PreviewPanel } from '../../../../components/task-detail/preview-panel';
import { SubTasksSection } from '../../../../components/task-detail/sub-tasks-section';
import { TaskHeader } from '../../../../components/task-detail/task-header';
import { TaskSidebar } from '../../../../components/task-detail/task-sidebar';
import { TaskSummary } from '../../../../components/task-detail/task-summary';
import { ResizableSplit, usePanelPresence } from '../../../../components/ui/resizable-split';
import { useRegisterScrollContent } from '../../../../contexts/scroll-content-context';
import { useAgents } from '../../../../hooks/use-agents';
import {
	type Comment,
	useCommentSkeletons,
	useCreateComment,
} from '../../../../hooks/use-comments';
import { useExecutionLock } from '../../../../hooks/use-execution-locks';
import { useInstanceSettings } from '../../../../hooks/use-instance-settings';
import { useScrollToBottom } from '../../../../hooks/use-scroll-to-bottom';
import { useTask, useUpdateTask } from '../../../../hooks/use-tasks';
import { PANEL_MOTION_TRANSITION } from '../../../../lib/panel-motion';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Everything below this boundary is per-task-VISIT state: the open document
 * preview, the reply target, the view override, the mobile meta drawer. The
 * router reuses ONE component instance for every task on this route, so a plain
 * `useState` survives a task→task navigation and leaks into the next task —
 * the previous task's document stayed pinned in the preview panel, and a stale
 * `replyTarget` would parent the next comment to a comment on another task.
 *
 * Remounting on task identity is what makes "per visit" true, and keeps it true
 * for state added later without every new `useState` having to remember to
 * reset itself. Nothing worth carrying across tasks lives here — the preview
 * panel's width is in localStorage and the task data is in the query cache, so
 * a remount costs a re-render, not a refetch.
 */
function TaskDetailPage() {
	const { projectId, taskId } = Route.useParams();
	return <TaskDetailView key={`${projectId}/${taskId}`} projectId={projectId} taskId={taskId} />;
}

function TaskDetailView({ projectId, taskId }: { projectId: string; taskId: string }) {
	const navigate = useNavigate();
	const { data: task, isLoading } = useTask(projectId, taskId);

	// Fallback canonicalization for the cold-load case: the cache-only check
	// in `beforeLoad` only redirects when the task is already cached, so a
	// direct URL hit with a UUID still renders the wrong URL for one frame.
	// Once the task data lands, redirect to the canonical URL.
	useEffect(() => {
		if (!task?.identifier || !task?.project_slug) return;
		const friendlyId = task.identifier.toLowerCase();
		const canonicalProject = task.project_slug;
		const needsIdNormalization = UUID_RE.test(taskId) && taskId !== friendlyId;
		const needsProjectNormalization = projectId !== canonicalProject;
		if (needsIdNormalization || needsProjectNormalization) {
			navigate({
				to: '/projects/$projectId/tasks/$taskId',
				params: { projectId: canonicalProject, taskId: friendlyId },
				// Preserve a deep-link hash (`#comment-<id>`) across the canonical
				// redirect so it can't be stripped before the scroll fires.
				hash: window.location.hash ? window.location.hash.replace(/^#/, '') : undefined,
				replace: true,
			});
		}
	}, [task?.identifier, task?.project_slug, taskId, projectId, navigate]);

	// The comments feed loads skeletons (metadata, no heavy bodies); this drives
	// the count badge and the sidebar's run-comment lookup. Bodies load lazily
	// inside CommentsSection as rows settle into view.
	const { data: comments } = useCommentSkeletons(projectId, taskId);
	const { data: agents } = useAgents(projectId);
	const { data: lock } = useExecutionLock(projectId, taskId);
	const updateTask = useUpdateTask(projectId, taskId);
	const createComment = useCreateComment(projectId, taskId);
	// Per-comment reasoning effort. `null` = user hasn't touched the dropdown, so
	// leave effort unset on submit and let the server resolve the agent default.
	const [commentEffort, setCommentEffort] = useState<AgentEffort | null>(null);
	const [replyTarget, setReplyTarget] = useState<Comment | null>(null);
	// Which view this page visit shows. The instance default is the value; the
	// rail control overrides it for this visit only and writes nothing, so a
	// reload - or opening another task - is back on the default. Plain state plus
	// the remount above is the whole of the per-visit rule; nothing to go stale.
	const { data: instanceSettings } = useInstanceSettings();
	const defaultView = instanceSettings?.default_task_view ?? DEFAULT_TASK_VIEW;
	const [viewOverride, setViewOverride] = useState<TaskView | null>(null);
	const view = viewOverride ?? defaultView;
	// A doc clicked in a comment opens in the preview panel: an in-grid column at
	// lg+ that defaults to widening on the roomier xl/2xl breakpoints (up to 2× its
	// base width) and is user-resizable by dragging the divider between it and the
	// task content (persisted in localStorage); and its own full-screen overlay
	// (above the main content and the meta drawer) below lg. It is independent of
	// the meta side rail, and scoped to this task by the remount above — a doc
	// opened from one task's comments must not follow the reader into the next.
	const [preview, setPreview] = useState<PreviewItem | null>(null);
	// The meta side rail is a collapsed-by-default drawer on mobile, toggled by
	// the chevron. It is independent of the preview panel — opening/closing a
	// preview must not affect it (otherwise closing a doc reveals the meta panel).
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const openPreview = (item: PreviewItem) => setPreview(item);
	const commentFormRef = useRef<HTMLFormElement>(null);
	const commentTextareaRef = useRef<HTMLTextAreaElement>(null);

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

	// The jump-to-bottom button itself is global (rendered by the shell over
	// <main> — see __root.tsx); this hook instance only provides scrollToBottom
	// for the sidebar's close/re-open actions.
	const { scrollToBottom } = useScrollToBottom(scrollParent);

	// This page's <main> holds a two-column grid at lg+ (content column + sticky
	// meta rail). Register the content column so the global scroll pills centre
	// over it, not over content + the non-scrolling rail.
	const registerScrollContent = useRegisterScrollContent();

	if (isLoading || !task)
		return <div className="text-text-2 text-[13px] py-8 text-center">Loading...</div>;

	function startReply(c: Comment) {
		setReplyTarget(c);
		requestAnimationFrame(() => {
			commentFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
			commentTextareaRef.current?.focus();
		});
	}

	const taskProjectSlug = task.project_slug ?? projectId;

	return (
		<ResizableSplit
			side="right"
			storageKey="hezo:preview-panel-width"
			defaultTrackClass="lg:grid-cols-[1fr_360px] xl:grid-cols-[1fr_520px] 2xl:grid-cols-[1fr_720px]"
			collapsedTrackClass="lg:grid-cols-[1fr_190px]"
			panel={
				preview ? (
					<PreviewPanel
						item={preview}
						onClose={() => setPreview(null)}
						task={{ projectId, taskId, identifier: task.identifier, title: task.title }}
					/>
				) : null
			}
			aside={
				<TaskMetaRail
					open={sidebarOpen}
					onToggle={() => setSidebarOpen((o) => !o)}
					onClose={() => setSidebarOpen(false)}
					previewOpen={!!preview}
				>
					<TaskSidebar
						task={task}
						projectId={projectId}
						taskId={taskId}
						agents={agents}
						lock={lock}
						comments={comments}
						updateTask={updateTask}
						commentEffort={commentEffort}
						setCommentEffort={setCommentEffort}
						scrollToBottom={scrollToBottom}
						view={view}
						setView={setViewOverride}
						defaultView={defaultView}
					/>
				</TaskMetaRail>
			}
		>
			<PreviewProvider value={openPreview}>
				<div ref={registerScrollContent} data-testid="task-content" className="min-w-0">
					<LastRunFailedBanner task={task} />
					<TaskHeader
						task={task}
						projectId={projectId}
						taskId={taskId}
						taskProjectSlug={taskProjectSlug}
						updateTask={updateTask}
					/>

					<TaskSummary
						task={task}
						projectId={projectId}
						taskProjectSlug={taskProjectSlug}
						updateTask={updateTask}
					/>

					<SubTasksSection
						projectId={projectId}
						parentTaskId={task.id}
						parentIdentifier={task.identifier}
						taskProjectSlug={taskProjectSlug}
					/>

					<DependenciesSection projectId={projectId} taskId={taskId} />

					<div className="border-t border-border pt-4">
						<CommentsSection
							task={task}
							projectId={projectId}
							taskId={taskId}
							taskProjectSlug={taskProjectSlug}
							scrollParent={scrollParent}
							onStartReply={startReply}
							view={view}
						/>

						<CommentComposer
							task={task}
							projectId={projectId}
							taskProjectSlug={taskProjectSlug}
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
			</PreviewProvider>
		</ResizableSplit>
	);
}

/**
 * The task meta rail. Mobile: a fixed right-side drawer toggled by the chevron.
 * Desktop: `lg:contents` makes this wrapper generate no box, so TaskSidebar
 * becomes the direct grid child (in-grid sticky column).
 *
 * While a preview is open the rail yields its column to it (`lg:hidden`) — and
 * stays yielded until the preview has finished its exit, which is why this reads
 * the split's presence rather than `previewOpen` alone. Returning a frame early
 * puts the rail behind a panel still fading out, in the slot they share. On
 * mobile the preview is its own overlay above this.
 *
 * It renders under ResizableSplit's provider (it is passed as `aside`), so the
 * presence hook resolves; a component defined outside that tree would read the
 * default `open` forever.
 */
function TaskMetaRail({
	open,
	onToggle,
	onClose,
	previewOpen,
	children,
}: {
	open: boolean;
	onToggle: () => void;
	onClose: () => void;
	previewOpen: boolean;
	children: ReactNode;
}) {
	const closing = usePanelPresence() === 'closing';
	const yielded = previewOpen || closing;
	return (
		<>
			{/* Right rail: an in-grid sticky column at lg+, a slide-in floating
			    drawer below lg (collapsed by default, toggled by the chevron). */}
			<button
				type="button"
				onClick={onToggle}
				data-testid="task-sidebar-toggle"
				aria-label={open ? 'Collapse task details' : 'Expand task details'}
				aria-expanded={open}
				className="lg:hidden fixed right-0 top-1/2 -translate-y-1/2 z-50 h-12 w-7 rounded-l-md border border-r-0 border-border bg-surface text-text-2 hover:text-text-1 shadow-md flex items-center justify-center"
			>
				{open ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
			</button>
			{open && (
				<button
					type="button"
					aria-label="Close task details"
					onClick={onClose}
					className="lg:hidden fixed inset-0 z-40 bg-[var(--overlay)] cursor-default"
				/>
			)}
			<div
				data-testid="task-rail"
				className={`fixed top-0 right-0 z-40 h-full w-[280px] max-w-[85vw] overflow-y-auto bg-surface p-4 shadow-xl transition-transform ${PANEL_MOTION_TRANSITION} ${
					open ? 'translate-x-0' : 'translate-x-full'
				} ${yielded ? 'lg:hidden' : 'lg:contents'}`}
			>
				{children}
			</div>
		</>
	);
}

export const Route = createFileRoute('/projects/$projectId/tasks/$taskId')({
	component: TaskDetailPage,
});
