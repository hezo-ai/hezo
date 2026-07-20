import { CommentContentType } from '@hezo/shared';
import { Loader2 } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { type Comment, useComments } from '../hooks/use-comments';
import { Avatar, getInitials } from './ui/avatar';
import { RelativeTime } from './ui/relative-time';

/** Intake bubble min-height (py-2.5 + one line); the `chat` avatar size matches it. */
const captainChatBubbleMinHClass = 'min-h-[2.625rem]';
/** Indent name/timestamp to align with bubble column (avatar width + gap). */
const captainChatMetaIndentClass = 'pl-[calc(2.625rem+0.625rem)]';

function getCommentText(content: Comment['content']): string {
	if (typeof content === 'string') {
		try {
			const parsed = JSON.parse(content) as { text?: string };
			if (typeof parsed.text === 'string') return parsed.text;
		} catch {
			return content;
		}
		return content;
	}
	if (typeof content === 'object' && content !== null && 'text' in content) {
		const text = (content as { text?: unknown }).text;
		return typeof text === 'string' ? text : '';
	}
	return '';
}

interface CaptainIntakeChatProps {
	projectSlug: string;
	taskIdentifier: string;
	captainTitle: string;
	awaitingCaptainReply: boolean;
}

export function CaptainIntakeChat({
	projectSlug,
	taskIdentifier,
	captainTitle,
	awaitingCaptainReply,
}: CaptainIntakeChatProps) {
	const scrollRef = useRef<HTMLDivElement>(null);

	const { data: comments, isLoading } = useComments(projectSlug, taskIdentifier);

	const chatMessages = useMemo(() => {
		return (comments ?? []).filter((c) => c.content_type === CommentContentType.Text);
	}, [comments]);

	const lastMessageId = chatMessages.at(-1)?.id;

	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new messages and typing indicator
	useEffect(() => {
		if (isLoading) return;
		const el = scrollRef.current;
		if (!el) return;
		const scrollToLatest = () => {
			el.scrollTop = el.scrollHeight;
		};
		scrollToLatest();
		requestAnimationFrame(scrollToLatest);
	}, [isLoading, lastMessageId, awaitingCaptainReply]);

	if (isLoading) {
		return (
			<div
				className="flex items-center justify-center py-10 text-text-2 text-[13px]"
				data-testid="home-captain-chat-loading"
			>
				<Loader2 className="w-4 h-4 animate-spin mr-2" />
				Loading conversation…
			</div>
		);
	}

	return (
		<div
			ref={scrollRef}
			className="flex flex-col gap-3 max-h-[min(65vh,520px)] overflow-y-auto px-1 py-1 scroll-smooth"
			data-testid="home-captain-chat"
		>
			{chatMessages.map((comment) => {
				const isCaptain = comment.author_type === 'agent';
				const text = getCommentText(comment.content);
				if (!text.trim()) return null;

				if (isCaptain) {
					return (
						<div
							key={comment.id}
							className="flex flex-col gap-1 min-w-0 max-w-[min(100%,42rem)]"
							data-testid="home-captain-chat-message"
							data-role="captain"
						>
							<span className={`text-[11px] font-medium text-text-2 ${captainChatMetaIndentClass}`}>
								{comment.author_name ?? captainTitle}
							</span>
							<div className="flex gap-2.5 items-center">
								<Avatar size="chat" initials={getInitials(comment.author_name ?? captainTitle)} />
								<div
									className={`flex-1 min-w-0 rounded-md rounded-bl-sm bg-surface-2 border border-border px-3 py-2.5 ${captainChatBubbleMinHClass} text-[13px] md:text-sm text-text-1 leading-relaxed whitespace-pre-wrap`}
								>
									{text}
								</div>
							</div>
							<RelativeTime
								iso={comment.created_at}
								className={`text-[10px] text-text-3 ${captainChatMetaIndentClass}`}
							/>
						</div>
					);
				}

				return (
					<div
						key={comment.id}
						className="flex flex-col items-end gap-1 min-w-0"
						data-testid="home-captain-chat-message"
						data-role="admin"
					>
						<span className="text-[11px] font-medium text-text-2 pr-0.5">You</span>
						<div className="max-w-[min(100%,42rem)] rounded-md rounded-br-sm bg-info-soft border border-info-soft-fg/20 px-3 py-2.5 text-[13px] md:text-sm text-text-1 leading-relaxed whitespace-pre-wrap">
							{text}
						</div>
						<RelativeTime iso={comment.created_at} className="text-[10px] text-text-3 pr-0.5" />
					</div>
				);
			})}

			{awaitingCaptainReply && (
				<div
					className="flex gap-2.5 items-center max-w-[min(100%,42rem)]"
					data-testid="home-captain-chat-typing"
					aria-live="polite"
				>
					<Avatar size="chat" initials={getInitials(captainTitle)} className="opacity-80" />
					<div
						className={`flex-1 min-w-0 rounded-md rounded-bl-sm bg-surface-2 border border-border px-3 py-2.5 ${captainChatBubbleMinHClass} flex items-center`}
					>
						<span className="inline-flex gap-1 items-center text-text-2 text-[13px]">
							<span className="w-1.5 h-1.5 rounded-full bg-text-3 animate-pulse" />
							<span className="w-1.5 h-1.5 rounded-full bg-text-3 animate-pulse [animation-delay:150ms]" />
							<span className="w-1.5 h-1.5 rounded-full bg-text-3 animate-pulse [animation-delay:300ms]" />
						</span>
					</div>
				</div>
			)}
		</div>
	);
}
