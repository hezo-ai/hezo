import { CornerDownRight, Reply } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { useAgents } from '../../hooks/use-agents';
import { type Comment, useChooseOption, useComments } from '../../hooks/use-comments';
import type { Task } from '../../hooks/use-tasks';
import { AgentLink } from '../agent-link';
import {
	type CommentData,
	CommentReactions,
	CommentRenderer,
	inlineEventIcon,
	isInlineEventType,
} from '../comment-renderers';
import { Avatar, avatarColorFromString } from '../ui/avatar';

/** Drive the page's hashchange handler from any anchor — Virtuoso may not
 * have the target row mounted yet, so the scroll has to flow through the
 * `useEffect` below. */
export function jumpToComment(commentId: string) {
	return (e: React.MouseEvent) => {
		e.preventDefault();
		const target = `#comment-${commentId}`;
		window.history.pushState(null, '', target);
		window.dispatchEvent(new HashChangeEvent('hashchange'));
	};
}

interface CommentsSectionProps {
	task: Task;
	projectId: string;
	taskId: string;
	taskProjectSlug: string;
	scrollParent: HTMLElement | null;
	onStartReply: (comment: Comment) => void;
}

/**
 * Virtualized comments list. Manages its own task-switch scroll reset and
 * the hash-scroll logic that drives `#comment-<id>` / `#setup-repo` deep
 * links. `customScrollParent` MUST stay wired to the route's `<main>`
 * element — Virtuoso's default window-scroll mode returns 0 for
 * scrollHeight under happy-dom and disables the scroll-to-bottom button.
 */
export function CommentsSection({
	task,
	projectId,
	taskId,
	taskProjectSlug,
	scrollParent,
	onStartReply,
}: CommentsSectionProps) {
	const { data: comments } = useComments(projectId, taskId);
	// Resolve agent comment authors to their slug so the avatar + name link to
	// the agent's page. Reads the already-cached team roster; cross-team authors
	// (CEO / Coach) aren't in it and stay unlinked.
	const { data: agents } = useAgents(projectId);
	const agentSlugById = useMemo(() => {
		const m = new Map<string, string>();
		for (const a of agents ?? []) m.set(a.id, a.slug);
		return m;
	}, [agents]);
	const chooseOption = useChooseOption(projectId, taskId);
	const virtuosoRef = useRef<VirtuosoHandle>(null);
	const listContainerRef = useRef<HTMLDivElement>(null);
	const didScrollToHashRef = useRef(false);
	const [highlightedCommentId, setHighlightedCommentId] = useState<string | null>(null);
	const lastResetTaskIdRef = useRef<string | null>(null);

	useLayoutEffect(() => {
		if (!scrollParent) return;
		if (lastResetTaskIdRef.current === taskId) return;
		const hash = typeof window !== 'undefined' ? window.location.hash : '';
		const hasJumpHash = hash.startsWith('#comment-') || hash === '#setup-repo';
		if (!hasJumpHash) scrollParent.scrollTop = 0;
		lastResetTaskIdRef.current = taskId;
	}, [taskId, scrollParent]);

	useEffect(() => {
		if (!comments || comments.length === 0) return;
		if (typeof window === 'undefined') return;

		// Resolve the current hash (a specific comment via `#comment-<id>`, or
		// the unresolved setup-repo action card via `#setup-repo`) to its
		// index in the loaded comments list and tell Virtuoso to scroll there.
		// `scrollToIndex` is computed off estimated row heights, so iterate a
		// few times: each pass mounts more rows, grows the measured document,
		// and the next call lands closer to the target.
		const scrollToHash = () => {
			const hash = window.location.hash;
			let idx = -1;
			let highlightId: string | null = null;
			if (hash.startsWith('#comment-')) {
				const targetId = hash.slice('#comment-'.length);
				idx = comments.findIndex((c) => c.id === targetId);
				if (idx >= 0) highlightId = targetId;
			} else if (hash === '#setup-repo') {
				idx = comments.findIndex((c) => {
					if (c.content_type !== 'action') return false;
					const content = typeof c.content === 'object' ? (c.content as { kind?: string }) : null;
					return content?.kind === 'setup_repo' && !c.chosen_option;
				});
			}
			if (idx < 0) return [] as ReturnType<typeof setTimeout>[];
			const out: ReturnType<typeof setTimeout>[] = [];
			// Virtuoso with `customScrollParent` only mounts items once its
			// container intersects the parent's viewport. On a fresh task page
			// load, the comments list starts far below the fold (header,
			// description, sidebar, etc.) and Virtuoso's IntersectionObserver
			// never fires — so itemContent is never called, no row exists in
			// the DOM, and `scrollToIndex` has no measured rows to land on.
			// Force the parent to scroll the list container into view first;
			// that wakes the IntersectionObserver and Virtuoso starts mounting.
			if (listContainerRef.current && scrollParent) {
				const listTop = listContainerRef.current.getBoundingClientRect().top;
				const parentTop = scrollParent.getBoundingClientRect().top;
				const offset = scrollParent.scrollTop + listTop - parentTop;
				scrollParent.scrollTo({ top: Math.max(0, offset - 80), behavior: 'auto' });
			}
			// Each tick: first ask Virtuoso to mount the target row, then read
			// the rendered element's real position and scroll precisely to it.
			// Virtuoso's scrollToIndex alone underscrolls when the row's height
			// grows after mount (LazyMount in run comments, async log body),
			// because the offset is computed from stale estimates. The extra
			// 3000ms tick absorbs the post-fetch height jump.
			const scrollDelays = [16, 200, 600, 1500, 3000];
			for (const delay of scrollDelays) {
				out.push(
					setTimeout(() => {
						virtuosoRef.current?.scrollToIndex({ index: idx, align: 'center' });
						if (highlightId) {
							const el = document.getElementById(`comment-${highlightId}`);
							el?.scrollIntoView({ block: 'center', behavior: 'auto' });
						}
					}, delay),
				);
			}
			if (highlightId) {
				setHighlightedCommentId(highlightId);
				// Clear the highlight 2s AFTER the last scroll attempt — under load,
				// Virtuoso may not mount the target row until that final attempt, so
				// the highlight must outlive row mount or it flashes invisibly.
				const lastScrollDelay = scrollDelays[scrollDelays.length - 1];
				out.push(
					setTimeout(() => {
						setHighlightedCommentId(null);
					}, lastScrollDelay + 2000),
				);
				window.history.replaceState(null, '', window.location.pathname + window.location.search);
			}
			if (hash === '#setup-repo') {
				window.history.replaceState(null, '', window.location.pathname + window.location.search);
			}
			return out;
		};

		const initialTimers = didScrollToHashRef.current ? [] : scrollToHash();
		didScrollToHashRef.current = true;

		const allTimers: ReturnType<typeof setTimeout>[] = [...initialTimers];
		const onHashChange = () => {
			allTimers.push(...scrollToHash());
		};
		window.addEventListener('hashchange', onHashChange);
		return () => {
			window.removeEventListener('hashchange', onHashChange);
			for (const t of allTimers) clearTimeout(t);
		};
	}, [comments, scrollParent]);

	return (
		<div ref={listContainerRef} className="mb-4" data-testid="comments-list">
			{scrollParent && (
				<Virtuoso
					ref={virtuosoRef}
					customScrollParent={scrollParent}
					data={comments ?? []}
					computeItemKey={(_, c) => c.id}
					defaultItemHeight={120}
					increaseViewportBy={{ top: 600, bottom: 600 }}
					itemContent={(_, c) => {
						const commentData = c as unknown as CommentData;
						const authorName = c.author_name ?? 'Admin';
						const isAgent = c.author_type === 'agent';
						const authorAgentSlug =
							isAgent && c.author_member_id ? agentSlugById.get(c.author_member_id) : undefined;
						const content = typeof c.content === 'object' ? (c.content as { kind?: string }) : null;
						const isPendingSetupRepo =
							c.content_type === 'action' && content?.kind === 'setup_repo' && !c.chosen_option;
						const isHighlighted = highlightedCommentId === c.id;

						if (isInlineEventType(c.content_type)) {
							const Icon = inlineEventIcon(commentData);
							return (
								<div
									id={`comment-${c.id}`}
									className={`flex items-start gap-2.5 scroll-mt-20 pb-4 ${isHighlighted ? 'rounded-md ring-2 ring-accent-blue/60 transition-shadow' : ''}`}
									data-testid="comment-item"
									data-comment-highlighted={isHighlighted ? 'true' : undefined}
								>
									<div
										data-testid="inline-event-icon"
										className="w-[26px] h-[26px] flex items-center justify-center shrink-0 text-text-subtle"
									>
										<Icon className="w-3.5 h-3.5" />
									</div>
									<div className="flex-1 min-w-0">
										<CommentRenderer
											comment={commentData}
											onChooseOption={(commentId, chosenId) =>
												chooseOption.mutate({ commentId, chosen_id: chosenId })
											}
											projectId={projectId}
											projectSlug={taskProjectSlug}
											taskId={taskId}
											inline
										/>
									</div>
								</div>
							);
						}

						return (
							<div
								id={`comment-${c.id}`}
								className={`flex gap-2.5 scroll-mt-20 pb-4 ${isHighlighted ? 'rounded-md ring-2 ring-accent-blue/60 transition-shadow' : ''}`}
								data-testid="comment-item"
								data-comment-highlighted={isHighlighted ? 'true' : undefined}
								{...(isPendingSetupRepo ? { 'data-setup-repo-anchor': '' } : {})}
							>
								{authorAgentSlug ? (
									<AgentLink
										projectId={projectId}
										agentId={authorAgentSlug}
										title={`View ${authorName}`}
										testId="comment-author-avatar-link"
										className="shrink-0 rounded-full"
									>
										<Avatar
											initials={authorName.slice(0, 2)}
											size="sm"
											color={avatarColorFromString(authorName)}
										/>
									</AgentLink>
								) : (
									<Avatar
										initials={authorName.slice(0, 2)}
										size="sm"
										color={avatarColorFromString(authorName)}
									/>
								)}
								<div className="flex-1 min-w-0 rounded-md border border-border bg-bg-elevated overflow-hidden">
									<div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-bg-muted">
										{authorAgentSlug ? (
											<AgentLink
												projectId={projectId}
												agentId={authorAgentSlug}
												className="text-xs font-medium text-text hover:text-accent-blue-text transition-colors"
												testId="comment-author"
											>
												{authorName}
											</AgentLink>
										) : (
											<span
												className={`text-xs font-medium ${isAgent ? 'text-text' : 'text-text-muted'}`}
												data-testid="comment-author"
											>
												{authorName}
											</span>
										)}
										<span className="text-[11px] text-text-subtle">
											{new Date(c.created_at).toLocaleString()}
										</span>
										{c.parent_comment_id &&
											(() => {
												const parent = comments?.find((x) => x.id === c.parent_comment_id);
												if (!parent) return null;
												return (
													<a
														href={`#comment-${parent.id}`}
														onClick={jumpToComment(parent.id)}
														className="ml-auto flex items-center gap-1 text-[11px] text-text-subtle hover:text-text"
														data-testid="replying-to"
													>
														<CornerDownRight className="w-3 h-3" />
														replying to {parent.author_name}
													</a>
												);
											})()}
									</div>
									<div className="px-3 py-2.5">
										<CommentRenderer
											comment={commentData}
											onChooseOption={(commentId, chosenId) =>
												chooseOption.mutate({ commentId, chosen_id: chosenId })
											}
											projectId={projectId}
											projectSlug={taskProjectSlug}
											taskId={taskId}
										/>
										<div className="flex items-end justify-between gap-2">
											<div className="min-w-0 flex-1">
												<CommentReactions
													comment={commentData}
													projectId={projectId}
													taskId={taskId}
												/>
											</div>
											<button
												type="button"
												onClick={() => onStartReply(c)}
												className="mt-2 text-text-subtle hover:text-text shrink-0 p-1 -m-1"
												aria-label="Reply to comment"
												data-testid="comment-reply"
											>
												<Reply className="w-3.5 h-3.5" />
											</button>
										</div>
									</div>
								</div>
							</div>
						);
					}}
				/>
			)}
		</div>
	);
}
