import { CommentContentType } from '@hezo/shared';
import { Check, Copy, CornerDownRight, Reply } from 'lucide-react';
import type { Agent } from '../../hooks/use-agents';
import {
	type Comment,
	type CommentSkeleton,
	skeletonNeedsBody,
	useCommentBody,
} from '../../hooks/use-comments';
import { useCopyFeedback } from '../../hooks/use-copy-feedback';
import { agentAvatarUrl } from '../../lib/agent-avatar';
import { agentDisplayName } from '../agent-identity-tooltip';
import { AgentRef } from '../agent-ref';
import {
	type CommentData,
	CommentReactions,
	CommentRenderer,
	CommentTimestampLink,
	commentText,
	inlineEventIcon,
	isInlineEventType,
	jumpToComment,
} from '../comment-renderers';
import { ActorBadge } from '../ui/actor-badge';
import { Avatar, avatarColorFromString } from '../ui/avatar';

/**
 * Copies a comment's markdown body to the clipboard, swapping its icon to a
 * check for 1.5s as confirmation (mirrors the log-viewer copy affordance).
 */
function CopyCommentButton({ text }: { text: string }) {
	const { copied, copy } = useCopyFeedback();

	const handleCopy = async () => {
		await copy(text);
	};

	return (
		<button
			type="button"
			onClick={handleCopy}
			className="text-text-3 hover:text-text-1 shrink-0 p-1 -m-1"
			aria-label={copied ? 'Copied' : 'Copy comment'}
			data-testid="comment-copy"
		>
			{copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
		</button>
	);
}

/** Shimmer standing in for a comment body until it loads on scroll-dwell. Its
 *  height is derived from the skeleton's `text_length` so the row reserves close
 *  to its final height and the thread doesn't jump when the body lands. */
function CommentBodyPlaceholder({ textLength }: { textLength: number | null }) {
	// ~52 characters per rendered line; clamp to a sane 1–6 bar range.
	const lines = Math.min(6, Math.max(1, Math.round((textLength ?? 60) / 52)));
	return (
		<div className="space-y-2 py-0.5" data-testid="comment-body-placeholder" aria-hidden>
			{Array.from({ length: lines }).map((_, i) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length shimmer, order is stable
					key={i}
					className="h-3 rounded bg-surface-3 animate-pulse"
					style={{ width: i === lines - 1 ? '55%' : `${88 - (i % 3) * 9}%` }}
				/>
			))}
		</div>
	);
}

interface CommentRowProps {
	comment: CommentSkeleton;
	comments: CommentSkeleton[];
	projectId: string;
	taskProjectSlug: string;
	taskId: string;
	retryableRunId: string | null;
	isHighlighted: boolean;
	agentsByMemberId: Map<string, Agent>;
	observeCommentRow: (el: HTMLDivElement | null) => void;
	onStartReply: (comment: Comment) => void;
}

/**
 * One row of the lazy comments feed. Inline-event rows (system/run) render
 * straight from the skeleton. Other rows render their chrome (avatar, author,
 * timestamp) from the skeleton immediately and lazily load their body — the feed
 * triggers the batched fetch on scroll-dwell; this row subscribes via
 * `useCommentBody` and swaps its placeholder for the real body once it lands.
 */
export function CommentRow({
	comment: c,
	comments,
	projectId,
	taskProjectSlug,
	taskId,
	retryableRunId,
	isHighlighted,
	agentsByMemberId,
	observeCommentRow,
	onStartReply,
}: CommentRowProps) {
	const needsBody = skeletonNeedsBody(c);
	const { data: body } = useCommentBody(projectId, taskId, c.id);
	const bodyLoaded = !needsBody || body !== undefined;

	const isAgent = c.author_type === 'agent';
	// Resolve the author against the live roster so the header follows a rename,
	// rather than showing whatever label was current when the row was written.
	const authorAgent =
		isAgent && c.author_member_id ? agentsByMemberId.get(c.author_member_id) : undefined;
	const authorName = (authorAgent && agentDisplayName(authorAgent)) || c.author_name || 'Admin';
	const authorAgentSlug = authorAgent?.slug;
	const contentObj = typeof c.content === 'object' ? (c.content as { kind?: string }) : null;
	const isPendingSetupRepo =
		c.content_type === 'action' && contentObj?.kind === 'setup_repo' && !c.chosen_option;

	// The renderer wants a full comment: merge the body's content/attachments over
	// the skeleton (reactions stay on the skeleton). For non-text rows the body is
	// only fetched to carry attachments — their `content` already lives on the skeleton.
	const mergedContent = c.content_type === CommentContentType.Text ? body?.content : c.content;
	const commentData = {
		...c,
		content: mergedContent,
		attachments: body?.attachments ?? [],
	} as unknown as CommentData;

	if (isInlineEventType(c.content_type)) {
		const Icon = inlineEventIcon(commentData);
		return (
			<div
				id={`comment-${c.public_id}`}
				ref={observeCommentRow}
				data-comment-id={c.id}
				className={`flex items-start gap-2.5 scroll-mt-20 pb-4 ${isHighlighted ? 'rounded-md ring-2 ring-info/60 transition-shadow' : ''}`}
				data-testid="comment-item"
				data-comment-highlighted={isHighlighted ? 'true' : undefined}
			>
				<div
					data-testid="inline-event-icon"
					className="w-[26px] h-[26px] flex items-center justify-center shrink-0 text-text-3"
				>
					<Icon className="w-3.5 h-3.5" />
				</div>
				<div className="flex-1 min-w-0">
					<CommentRenderer
						comment={commentData}
						projectId={projectId}
						projectSlug={taskProjectSlug}
						taskId={taskId}
						retryableRunId={retryableRunId}
						inline
					/>
				</div>
			</div>
		);
	}

	const parent = c.parent_comment_id
		? comments.find((x) => x.id === c.parent_comment_id)
		: undefined;

	return (
		<div
			id={`comment-${c.public_id}`}
			ref={observeCommentRow}
			data-comment-id={c.id}
			className={`flex gap-2.5 scroll-mt-20 pb-4 ${isHighlighted ? 'rounded-md ring-2 ring-info/60 transition-shadow' : ''}`}
			data-testid="comment-item"
			data-comment-highlighted={isHighlighted ? 'true' : undefined}
			{...(isPendingSetupRepo ? { 'data-setup-repo-anchor': '' } : {})}
		>
			{authorAgent ? (
				<AgentRef
					agent={authorAgent}
					projectId={projectId}
					link
					testId="comment-author-avatar-link"
					className="shrink-0 rounded-full"
				>
					<Avatar
						initials={authorName.slice(0, 2)}
						size="sm"
						color={avatarColorFromString(authorName)}
						imageUrl={
							c.author_icon_url ??
							agentAvatarUrl({ slug: authorAgentSlug, avatar_spec: c.author_avatar_spec })
						}
					/>
				</AgentRef>
			) : (
				<Avatar
					initials={authorName.slice(0, 2)}
					size="sm"
					color={avatarColorFromString(authorName)}
					imageUrl={c.author_icon_url}
				/>
			)}
			<div className="flex-1 min-w-0 rounded-md border border-border bg-surface overflow-hidden">
				<div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-surface-3">
					{authorAgent ? (
						<AgentRef
							agent={authorAgent}
							projectId={projectId}
							link
							className="text-xs font-medium text-text-1 hover:text-info-soft-fg transition-colors"
							testId="comment-author"
						/>
					) : (
						<span
							className={`text-xs font-medium ${isAgent ? 'text-text-1' : 'text-text-2'}`}
							data-testid="comment-author"
						>
							{authorName}
						</span>
					)}
					<ActorBadge actorType={c.author_type ?? undefined} name={authorName} />
					<CommentTimestampLink publicId={c.public_id} createdAt={c.created_at} />
					<div className="ml-auto flex items-center gap-2">
						{parent && (
							<a
								href={`#comment-${parent.public_id}`}
								onClick={jumpToComment(parent.public_id)}
								className="flex shrink-0 items-center gap-1 whitespace-nowrap text-[11px] text-text-3 hover:text-text-1"
								data-testid="replying-to"
							>
								<CornerDownRight className="w-3 h-3" />
								replying to {parent.author_name}
							</a>
						)}
						{c.content_type === CommentContentType.Text && bodyLoaded && (
							<CopyCommentButton text={commentText(mergedContent as never)} />
						)}
					</div>
				</div>
				<div className="px-3 py-2.5">
					{bodyLoaded ? (
						<>
							<CommentRenderer
								comment={commentData}
								projectId={projectId}
								projectSlug={taskProjectSlug}
								taskId={taskId}
								retryableRunId={retryableRunId}
							/>
							<div className="flex items-end justify-between gap-2">
								<div className="min-w-0 flex-1">
									<CommentReactions comment={commentData} projectId={projectId} taskId={taskId} />
								</div>
								<button
									type="button"
									onClick={() =>
										onStartReply({ ...c, content: mergedContent } as unknown as Comment)
									}
									className="mt-2 flex items-center gap-1 text-[11px] text-text-3 hover:text-text-1 shrink-0 p-1 -m-1"
									aria-label="Reply to comment"
									data-testid="comment-reply"
								>
									<Reply className="w-3.5 h-3.5" />
									Reply
								</button>
							</div>
						</>
					) : (
						<CommentBodyPlaceholder textLength={c.text_length} />
					)}
				</div>
			</div>
		</div>
	);
}
