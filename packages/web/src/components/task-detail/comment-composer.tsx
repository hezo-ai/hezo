import { type AgentEffort, extractActiveAgentMentionSlugs } from '@hezo/shared';
import * as Dialog from '@radix-ui/react-dialog';
import { CornerDownRight, Loader2, Maximize2, Minimize2, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useAgents } from '../../hooks/use-agents';
import { useAutoGrowTextarea } from '../../hooks/use-auto-grow-textarea';
import type { Comment, useCreateComment } from '../../hooks/use-comments';
import type { Task } from '../../hooks/use-tasks';
import { CommentAttachmentsDrop } from '../comment-attachments-drop';
import { MentionTextarea } from '../mention-textarea';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { DialogContent } from '../ui/dialog';
import { InfoTooltip } from '../ui/info-tooltip';

type CreateCommentMutation = ReturnType<typeof useCreateComment>;

interface CommentComposerProps {
	task: Task;
	projectId: string;
	taskProjectSlug: string;
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
 * drag-drop attachments target, a "Wake:" preview row that pills every agent
 * this comment will page, and the submit button. A comment wakes an agent only
 * when it actively `@`-mentions it (replying to an agent's comment counts too,
 * via WakeupSource.Reply) — there is no implicit assignee wake. The "Effort"
 * select lives in the sidebar but writes into the same commentEffort state —
 * owned by the route component and passed in. `replyTarget` is similarly owned
 * upstream so the comments list can `Reply →` into the composer.
 */
export function CommentComposer({
	task,
	projectId,
	taskProjectSlug,
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
	const [pendingAttachmentIds, setPendingAttachmentIds] = useState<string[]>([]);
	// Expand the composer to a full-viewport editor (available at every breakpoint —
	// the inline box is cramped on mobile too). In expanded mode the textarea fills
	// the space via flex; inline it auto-grows/shrinks with its content.
	const [expanded, setExpanded] = useState(false);

	// Auto-size the inline textarea to its content (capped by `max-h-[40vh]`, then it
	// scrolls). Disabled when expanded so the `flex-1` fill height wins instead.
	useAutoGrowTextarea(commentTextareaRef, [commentText, expanded], !expanded);

	// Focus the editor when it opens fullscreen so the user can type immediately.
	useEffect(() => {
		if (expanded) commentTextareaRef.current?.focus();
	}, [expanded, commentTextareaRef]);

	// Replying to an agent's comment wakes that agent (WakeupSource.Reply) even
	// without an explicit `@`-mention, so it joins the wake preview below.
	const replyingToAgent = replyTarget?.author_type === 'agent';

	const { data: agents } = useAgents(projectId);

	// The agents this comment will wake when posted: every actively `@`-mentioned
	// agent resolvable in the project roster (which includes the HQ CEO/Coach),
	// plus the reply-target agent. Deduped by id, so an agent that is both
	// mentioned and replied-to shows once. Mirrors the server's wakeup fan-out.
	const wakeAgents = useMemo(() => {
		const roster = agents ?? [];
		const bySlug = new Map(roster.map((a) => [a.slug.toLowerCase(), a] as const));
		const picked = new Map<string, { id: string; name: string }>();
		for (const slug of extractActiveAgentMentionSlugs(commentText)) {
			const a = bySlug.get(slug);
			if (a) picked.set(a.id, { id: a.id, name: a.title });
		}
		if (replyingToAgent && replyTarget) {
			const replyId = replyTarget.author_member_id;
			const a = replyId ? roster.find((r) => r.id === replyId) : undefined;
			const id = a?.id ?? replyId ?? `reply:${replyTarget.id}`;
			picked.set(id, { id, name: a?.title ?? replyTarget.author_name });
		}
		return Array.from(picked.values());
	}, [agents, commentText, replyingToAgent, replyTarget]);

	async function handleComment(e: React.FormEvent) {
		e.preventDefault();
		if (!commentText.trim() && pendingAttachmentIds.length === 0) return;
		await createComment.mutateAsync({
			content: commentText,
			...(commentEffort ? { effort: commentEffort } : {}),
			...(replyTarget ? { parent_comment_id: replyTarget.id } : {}),
			...(pendingAttachmentIds.length > 0 ? { attachment_ids: pendingAttachmentIds } : {}),
		});
		setCommentText('');
		setCommentEffort(null);
		setReplyTarget(null);
		setPendingAttachmentIds([]);
	}

	const formBody = (
		<form
			ref={commentFormRef}
			onSubmit={handleComment}
			className={expanded ? 'flex min-h-0 flex-1 flex-col gap-2' : 'flex gap-2.5 scroll-mt-20'}
		>
			{!expanded && <div className="hidden md:block w-[26px] shrink-0" aria-hidden />}
			<div className={`flex-1 min-w-0 flex flex-col gap-2${expanded ? ' min-h-0' : ''}`}>
				<CommentAttachmentsDrop
					projectId={projectId}
					taskId={task.id}
					value={pendingAttachmentIds}
					onChange={setPendingAttachmentIds}
					fill={expanded}
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
						containerClassName={expanded ? 'relative flex min-h-0 flex-1 flex-col' : 'relative'}
						wrapperClassName={expanded ? 'flex min-h-0 flex-1 flex-col' : undefined}
						className={
							expanded
								? 'flex-1 min-h-0 resize-none overflow-y-auto'
								: 'min-h-[60px] max-h-[40vh] resize-none overflow-y-auto'
						}
					/>
				</CommentAttachmentsDrop>
				{replyTarget && (
					<div
						className="flex items-center gap-2 text-[13px] text-text-2"
						data-testid="reply-indicator"
					>
						<CornerDownRight className="w-3.5 h-3.5 shrink-0" />
						<span className="shrink-0">In response to</span>
						<a
							href={`#comment-${replyTarget.public_id}`}
							onClick={jumpToComment(replyTarget.public_id)}
							className="truncate text-info hover:underline"
						>
							{replyTarget.author_name}: {previewCommentText(replyTarget)}
						</a>
						<button
							type="button"
							onClick={() => setReplyTarget(null)}
							className="text-text-3 hover:text-text-1 shrink-0"
							aria-label="Clear reply target"
							data-testid="clear-reply"
						>
							<Trash2 className="w-3.5 h-3.5" />
						</button>
					</div>
				)}
				<div className="flex flex-wrap items-center justify-between gap-2">
					<div
						className="flex flex-wrap items-center gap-1.5 min-w-0 text-[13px] text-text-2"
						data-testid="wake-preview"
					>
						<span className="shrink-0">Wake:</span>
						<InfoTooltip
							label="Who this comment wakes"
							data-testid="wake-preview-info"
							content={
								wakeAgents.length > 0
									? 'These agents will be woken up when this comment is posted.'
									: '@-mention an agent to wake it up when this comment is posted.'
							}
						/>
						{wakeAgents.length === 0 ? (
							<span className="text-text-3">(no one)</span>
						) : (
							wakeAgents.map((a) => (
								<Badge key={a.id} color="info" testId="wake-pill">
									{a.name}
								</Badge>
							))
						)}
					</div>
					<div className="flex items-center gap-2">
						<button
							type="button"
							onClick={() => setExpanded((v) => !v)}
							aria-label={expanded ? 'Collapse comment editor' : 'Expand comment editor'}
							data-testid="comment-expand"
							className="text-text-2 hover:text-text-1 p-1.5 -m-1 shrink-0"
						>
							{expanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
						</button>
						<Button
							type="submit"
							size="sm"
							disabled={
								(!commentText.trim() && pendingAttachmentIds.length === 0) ||
								createComment.isPending
							}
						>
							{createComment.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
							Comment
						</Button>
					</div>
				</div>
			</div>
		</form>
	);

	// Inline by default; in expanded mode the same form (and its state, which lives
	// above this conditional) is portalled into the shared fullscreen dialog so the
	// draft survives the inline↔dialog remount. The dialog's close button and Escape
	// both collapse it via `onOpenChange`.
	if (!expanded) return formBody;
	return (
		<Dialog.Root open onOpenChange={setExpanded}>
			<DialogContent
				fullscreen
				aria-describedby={undefined}
				data-testid="comment-composer-fullscreen"
			>
				<Dialog.Title className="text-lg font-semibold mb-4 pr-16 shrink-0">
					Add a comment
				</Dialog.Title>
				{formBody}
			</DialogContent>
		</Dialog.Root>
	);
}
