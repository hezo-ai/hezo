import type { AgentEffort } from '@hezo/shared';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ArrowDown } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { jumpToComment } from '../../../../components/comment-renderers';
import { CommentComposer } from '../../../../components/task-detail/comment-composer';
import { CommentsSection } from '../../../../components/task-detail/comments-section';
import { DependenciesSection } from '../../../../components/task-detail/dependencies-section';
import { LastRunFailedBanner } from '../../../../components/task-detail/last-run-failed-banner';
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
			<div className="grid grid-cols-1 lg:grid-cols-[1fr_190px] gap-5">
				<div className="min-w-0">
					<LastRunFailedBanner task={task} projectId={projectId} taskId={taskId} />
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
			</div>

			{/* Sits above the persistent CEO chat launcher (fixed bottom-right) so
			    the two floating controls don't overlap / intercept each other. */}
			<div
				className="sticky bottom-20 z-30 flex justify-end pointer-events-none"
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
		</>
	);
}

export const Route = createFileRoute('/projects/$projectId/tasks/$taskId')({
	component: TaskDetailPage,
});
