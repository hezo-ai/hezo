import type { AgentEffort } from '@hezo/shared';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ArrowDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
import { useAgents } from '../../../../hooks/use-agents';
import { type Comment, useComments, useCreateComment } from '../../../../hooks/use-comments';
import { useExecutionLock } from '../../../../hooks/use-execution-locks';
import { useScrollToBottom } from '../../../../hooks/use-scroll-to-bottom';
import { useTask, useUpdateTask } from '../../../../hooks/use-tasks';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function TaskDetailPage() {
	const { projectId, taskId } = Route.useParams();
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

	const { data: comments } = useComments(projectId, taskId);
	const { data: agents } = useAgents(projectId);
	const { data: lock } = useExecutionLock(projectId, taskId);
	const updateTask = useUpdateTask(projectId, taskId);
	const createComment = useCreateComment(projectId, taskId);
	// Per-comment reasoning effort. `null` = user hasn't touched the dropdown, so
	// leave effort unset on submit and let the server resolve the agent default.
	const [commentEffort, setCommentEffort] = useState<AgentEffort | null>(null);
	const [replyTarget, setReplyTarget] = useState<Comment | null>(null);
	// A doc/asset clicked in a comment opens in the right-rail preview panel
	// (replacing the metadata sidebar until closed).
	const [preview, setPreview] = useState<PreviewItem | null>(null);
	// On mobile the right rail is a collapsed-by-default drawer. Opening a preview
	// (a doc/asset clicked in a comment) must also open the drawer, otherwise the
	// preview would render off-screen behind the collapsed rail.
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const openPreview = (item: PreviewItem | null) => {
		setPreview(item);
		if (item) setSidebarOpen(true);
	};
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

	const { atBottom, scrollToBottom } = useScrollToBottom(scrollParent);

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
		<>
			<div
				className={`grid grid-cols-1 gap-5 ${preview ? 'lg:grid-cols-[1fr_360px]' : 'lg:grid-cols-[1fr_190px]'}`}
			>
				<PreviewProvider value={openPreview}>
					<div className="min-w-0">
						<LastRunFailedBanner task={task} />
						<TaskHeader
							task={task}
							projectId={projectId}
							taskId={taskId}
							taskProjectSlug={taskProjectSlug}
						/>

						<TaskSummary
							task={task}
							projectId={projectId}
							taskProjectSlug={taskProjectSlug}
							updateTask={updateTask}
						/>

						<SubTasksSection
							projectId={projectId}
							taskId={taskId}
							parentTaskId={task.id}
							taskProjectSlug={taskProjectSlug}
						/>

						<DependenciesSection projectId={projectId} taskId={taskId} />

						<div className="border-t border-border pt-4">
							<div className="flex items-center gap-1.5 mb-4">
								<h3 className="text-[13px] text-text-1 font-medium">Comments</h3>
								<span className="bg-surface-2 px-[7px] py-px rounded-full text-[11px] text-text-2">
									{comments?.length ?? 0}
								</span>
							</div>

							<CommentsSection
								task={task}
								projectId={projectId}
								taskId={taskId}
								taskProjectSlug={taskProjectSlug}
								scrollParent={scrollParent}
								onStartReply={startReply}
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

				{/* Right rail: an in-grid sticky column at lg+, a slide-in floating
				    drawer below lg (collapsed by default, toggled by the chevron). */}
				<button
					type="button"
					onClick={() => setSidebarOpen((o) => !o)}
					data-testid="task-sidebar-toggle"
					aria-label={sidebarOpen ? 'Collapse task details' : 'Expand task details'}
					aria-expanded={sidebarOpen}
					className="lg:hidden fixed right-0 top-1/2 -translate-y-1/2 z-50 h-12 w-7 rounded-l-md border border-r-0 border-border bg-surface text-text-2 hover:text-text-1 shadow-md flex items-center justify-center"
				>
					{sidebarOpen ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
				</button>
				{sidebarOpen && (
					<button
						type="button"
						aria-label="Close task details"
						onClick={() => setSidebarOpen(false)}
						className="lg:hidden fixed inset-0 z-40 bg-[var(--overlay)] cursor-default"
					/>
				)}
				{/* Mobile: a fixed right-side drawer. Desktop: `lg:contents` makes this
				    wrapper generate no box, so TaskSidebar/PreviewPanel become the direct
				    grid child again — preserving the in-grid sticky column unchanged. */}
				<div
					data-testid="task-rail"
					className={`fixed top-0 right-0 z-40 h-full w-[280px] max-w-[85vw] overflow-y-auto bg-surface p-4 shadow-xl transition-transform duration-200 ${
						sidebarOpen ? 'translate-x-0' : 'translate-x-full'
					} lg:contents`}
				>
					{preview ? (
						<PreviewPanel item={preview} onClose={() => setPreview(null)} />
					) : (
						<TaskSidebar
							task={task}
							projectId={projectId}
							agents={agents}
							lock={lock}
							comments={comments}
							updateTask={updateTask}
							commentEffort={commentEffort}
							setCommentEffort={setCommentEffort}
							scrollToBottom={scrollToBottom}
						/>
					)}
				</div>
			</div>

			{/* Desktop/tablet: a floating round button sitting above the persistent CEO
			    chat launcher (fixed bottom-right) so the two controls don't overlap. */}
			<div
				className="hidden lg:flex sticky bottom-20 z-30 justify-end pointer-events-none"
				aria-hidden={atBottom}
			>
				<button
					type="button"
					onClick={scrollToBottom}
					data-testid="task-scroll-to-bottom"
					aria-label="Scroll to bottom"
					tabIndex={atBottom ? -1 : 0}
					className={`w-9 h-9 rounded-full border border-border bg-surface text-text-2 hover:text-text-1 shadow-md flex items-center justify-center ${atBottom ? 'invisible' : 'pointer-events-auto'}`}
				>
					<ArrowDown className="w-4 h-4" />
				</button>
			</div>

			{/* Mobile: a rectangular button pinned bottom-centre, sitting between the
			    floating new-task (bottom-left) and CEO chat (bottom-right) launchers.
			    `bg-inverse` renders black in light theme and the theme-appropriate
			    inverse fill in dark theme, matching the chat launcher. */}
			<button
				type="button"
				onClick={scrollToBottom}
				data-testid="task-scroll-to-bottom-mobile"
				aria-label="Scroll to bottom"
				aria-hidden={atBottom}
				tabIndex={atBottom ? -1 : 0}
				className={`lg:hidden fixed bottom-4 left-1/2 -translate-x-1/2 z-40 flex h-7 items-center justify-center gap-1 rounded-md bg-inverse px-4 text-xs text-inverse-fg shadow-lg transition-opacity hover:opacity-90 ${atBottom ? 'invisible pointer-events-none opacity-0' : ''}`}
			>
				<ArrowDown className="h-4 w-4" />
			</button>
		</>
	);
}

export const Route = createFileRoute('/projects/$projectId/tasks/$taskId')({
	component: TaskDetailPage,
});
