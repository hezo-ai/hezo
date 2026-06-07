import type { AgentEffort } from '@hezo/shared';
import { CornerDownRight, Loader2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { Comment, useCreateComment } from '../../hooks/use-comments';
import type { Task } from '../../hooks/use-tasks';
import { CommentAttachmentsDrop } from '../comment-attachments-drop';
import { MentionTextarea } from '../mention-textarea';
import { Button } from '../ui/button';
import { ProjectIntakeBanner } from './project-intake-banner';

type CreateCommentMutation = ReturnType<typeof useCreateComment>;

interface CommentComposerProps {
	task: Task;
	projectId: string;
	taskId: string;
	taskProjectSlug: string;
	comments: Comment[] | undefined;
	createComment: CreateCommentMutation;
	commentEffort: AgentEffort | null;
	setCommentEffort: (value: AgentEffort | null) => void;
	replyTarget: Comment | null;
	setReplyTarget: (value: Comment | null) => void;
	jumpToComment: (commentId: string) => (e: React.MouseEvent) => void;
	commentFormRef: React.RefObject<HTMLFormElement | null>;
	commentTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
}

function previewCommentText(c: Comment): string {
	const raw = c.content as unknown;
	let text = '';
	if (typeof raw === 'string') text = raw;
	else if (raw && typeof raw === 'object' && 'text' in raw) {
		const t = (raw as { text?: unknown }).text;
		text = typeof t === 'string' ? t : '';
	}
	text = text.trim().replace(/\s+/g, ' ');
	if (!text) return '(non-text comment)';
	return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/**
 * The bottom-of-page comment-entry form: a MentionTextarea wrapped in a
 * drag-drop attachments target, a "wake assignee on submit" toggle (hidden when
 * replying to an agent's comment, since the reply already wakes that agent), the
 * project-intake skip affordance, and the submit button. The "Effort" select
 * lives in the sidebar but writes into the same commentEffort state — owned
 * by the route component and passed in. `replyTarget` is similarly owned
 * upstream so the comments list can `Reply →` into the composer.
 */
export function CommentComposer({
	task,
	projectId,
	taskId,
	taskProjectSlug,
	comments,
	createComment,
	commentEffort,
	setCommentEffort,
	replyTarget,
	setReplyTarget,
	jumpToComment,
	commentFormRef,
	commentTextareaRef,
}: CommentComposerProps) {
	const [commentText, setCommentText] = useState('');
	const [wakeAssignee, setWakeAssignee] = useState(true);
	const [pendingAttachmentIds, setPendingAttachmentIds] = useState<string[]>([]);

	// Replying to an agent's comment already wakes that agent (WakeupSource.Reply),
	// so the "wake assignee" toggle is redundant there — hide it and omit the flag.
	const replyingToAgent = replyTarget?.author_type === 'agent';

	async function handleComment(e: React.FormEvent) {
		e.preventDefault();
		if (!commentText.trim() && pendingAttachmentIds.length === 0) return;
		await createComment.mutateAsync({
			content: commentText,
			...(commentEffort ? { effort: commentEffort } : {}),
			...(task.assignee_id && !replyingToAgent ? { wake_assignee: wakeAssignee } : {}),
			...(replyTarget ? { parent_comment_id: replyTarget.id } : {}),
			...(pendingAttachmentIds.length > 0 ? { attachment_ids: pendingAttachmentIds } : {}),
		});
		setCommentText('');
		setCommentEffort(null);
		setWakeAssignee(true);
		setReplyTarget(null);
		setPendingAttachmentIds([]);
	}

	return (
		<form ref={commentFormRef} onSubmit={handleComment} className="flex gap-2.5 scroll-mt-20">
			<div className="w-[26px] shrink-0" aria-hidden />
			<div className="flex-1 min-w-0 flex flex-col gap-2">
				<CommentAttachmentsDrop
					projectId={projectId}
					taskId={task.id}
					value={pendingAttachmentIds}
					onChange={setPendingAttachmentIds}
				>
					<MentionTextarea
						ref={commentTextareaRef}
						projectId={projectId}
						projectSlug={taskProjectSlug}
						value={commentText}
						onChange={(e) => setCommentText(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
								e.preventDefault();
								commentFormRef.current?.requestSubmit();
							}
						}}
						placeholder="Add a comment..."
						className="min-h-[60px]"
					/>
				</CommentAttachmentsDrop>
				{replyTarget && (
					<div
						className="flex items-center gap-2 text-[13px] text-text-muted"
						data-testid="reply-indicator"
					>
						<CornerDownRight className="w-3.5 h-3.5 shrink-0" />
						<span className="shrink-0">In response to</span>
						<a
							href={`#comment-${replyTarget.id}`}
							onClick={jumpToComment(replyTarget.id)}
							className="truncate text-accent-blue hover:underline"
						>
							{replyTarget.author_name}: {previewCommentText(replyTarget)}
						</a>
						<button
							type="button"
							onClick={() => setReplyTarget(null)}
							className="text-text-subtle hover:text-text shrink-0"
							aria-label="Clear reply target"
							data-testid="clear-reply"
						>
							<Trash2 className="w-3.5 h-3.5" />
						</button>
					</div>
				)}
				<div className="flex items-center justify-end gap-2">
					<ProjectIntakeBanner
						task={task}
						projectId={projectId}
						taskId={taskId}
						comments={comments}
					/>
					{task.assignee_id && !replyingToAgent && (
						<label className="flex items-center gap-2 text-[13px] text-text-muted cursor-pointer select-none">
							<input
								type="checkbox"
								checked={wakeAssignee}
								onChange={(e) => setWakeAssignee(e.target.checked)}
								className="rounded"
								aria-label="Wake assignee on submit"
							/>
							<span>Wake assignee</span>
						</label>
					)}
					<Button
						type="submit"
						size="sm"
						disabled={
							(!commentText.trim() && pendingAttachmentIds.length === 0) || createComment.isPending
						}
					>
						{createComment.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
						Comment
					</Button>
				</div>
			</div>
		</form>
	);
}
