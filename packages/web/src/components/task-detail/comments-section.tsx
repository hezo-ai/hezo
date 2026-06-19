import { CommentContentType } from '@hezo/shared';
import { useLocation } from '@tanstack/react-router';
import { Check, Copy, CornerDownRight, Reply } from 'lucide-react';
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
	CommentTimestampLink,
	commentText,
	inlineEventIcon,
	isInlineEventType,
	jumpToComment,
} from '../comment-renderers';
import { Avatar, avatarColorFromString } from '../ui/avatar';

/**
 * Copies a comment's markdown body to the clipboard, swapping its icon to a
 * check for 1.5s as confirmation (mirrors the log-viewer copy affordance). A
 * standalone component because each comment row renders inside Virtuoso's
 * `itemContent` callback, where per-row hooks can't live.
 */
function CopyCommentButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		return () => {
			if (timeoutRef.current) clearTimeout(timeoutRef.current);
		};
	}, []);

	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			if (timeoutRef.current) clearTimeout(timeoutRef.current);
			timeoutRef.current = setTimeout(() => setCopied(false), 1500);
		} catch {
			// clipboard write failed (e.g. insecure context) — leave state unchanged
		}
	};

	return (
		<button
			type="button"
			onClick={handleCopy}
			className="text-text-subtle hover:text-text shrink-0 p-1 -m-1"
			aria-label={copied ? 'Copied' : 'Copy comment'}
			data-testid="comment-copy"
		>
			{copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
		</button>
	);
}

type HashScrollTarget = { idx: number; highlightId: string | null };

/**
 * Resolve a '#'-prefixed hash to a row in the loaded comments list.
 * `#comment-<id>` targets that comment (and highlights it); `#setup-repo`
 * targets the unresolved setup-repo action card. `idx` is -1 when the hash
 * points at nothing here — no jump hash, or the row hasn't loaded yet.
 */
function resolveHashTarget(hash: string, comments: Comment[]): HashScrollTarget {
	if (hash.startsWith('#comment-')) {
		const targetId = hash.slice('#comment-'.length);
		// Match by public_id (the canonical anchor) first, but also accept a raw
		// UUID so legacy/internal jump hashes still resolve. Normalize the
		// highlight id back to the matched comment's public_id, which is what the
		// DOM anchor uses.
		const idx = comments.findIndex((c) => c.public_id === targetId || c.id === targetId);
		return { idx, highlightId: idx >= 0 ? comments[idx].public_id : null };
	}
	if (hash === '#setup-repo') {
		const idx = comments.findIndex((c) => {
			if (c.content_type !== 'action') return false;
			const content = typeof c.content === 'object' ? (c.content as { kind?: string }) : null;
			return content?.kind === 'setup_repo' && !c.chosen_option;
		});
		return { idx, highlightId: null };
	}
	return { idx: -1, highlightId: null };
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
	// The run_id whose run_failed comment may show a Retry button: the most
	// recent run referenced in the thread, and only when no run is currently
	// active. Run comments (any outcome) and run_failed comments both carry a
	// run_id; comments arrive oldest-first, so the last match is the newest run.
	// Older failed runs — superseded by a later run, or any run while one is
	// active — resolve to a different id (or null) and hide their Retry button.
	const retryableRunId = useMemo<string | null>(() => {
		if (task.has_active_run) return null;
		let latest: string | null = null;
		for (const c of comments ?? []) {
			const content =
				c.content && typeof c.content === 'object'
					? (c.content as { run_id?: string; kind?: string })
					: null;
			const runId = content?.run_id;
			if (!runId) continue;
			if (
				c.content_type === 'run' ||
				(c.content_type === 'system' && content?.kind === 'run_failed')
			)
				latest = runId;
		}
		return latest;
	}, [comments, task.has_active_run]);
	const virtuosoRef = useRef<VirtuosoHandle>(null);
	const listContainerRef = useRef<HTMLDivElement>(null);
	const [highlightedCommentId, setHighlightedCommentId] = useState<string | null>(null);
	const lastResetTaskIdRef = useRef<string | null>(null);
	// Deep-link scroll. `hashTarget` is the '#'-prefixed hash we want to scroll
	// to, written from two sources (router navigations + raw window hash changes)
	// so it stays correct under both browser and memory history. It drives the
	// executor effect; `lastScrolledHashRef` records what we last scrolled to so a
	// WebSocket comments refetch can't yank the viewport back.
	const routerHash = useLocation({ select: (l) => l.hash });
	const [hashTarget, setHashTarget] = useState<string>(() =>
		typeof window !== 'undefined' ? window.location.hash : '',
	);
	const lastScrolledHashRef = useRef<string | null>(null);

	useLayoutEffect(() => {
		if (!scrollParent) return;
		if (lastResetTaskIdRef.current === taskId) return;
		const hash = typeof window !== 'undefined' ? window.location.hash : '';
		const hasJumpHash = hash.startsWith('#comment-') || hash === '#setup-repo';
		if (!hasJumpHash) scrollParent.scrollTop = 0;
		lastResetTaskIdRef.current = taskId;
	}, [taskId, scrollParent]);

	// Router navigations carry the deep-link hash here — `navigate({ hash })` from
	// the mention card, approval modal, and run-detail link. Reading it off the
	// router (rather than `window.location`) makes it reactive in both browser and
	// memory history, so it fires on a fresh cross-page mount and on same-task
	// re-navigation alike. `location.hash` has no leading '#'.
	useEffect(() => {
		if (routerHash) setHashTarget(`#${routerHash}`);
	}, [routerHash]);

	// The in-page `jumpToComment` helper changes the hash with a raw `pushState`
	// plus a dispatched `hashchange` (bypassing the router); browser back/forward
	// fires `popstate`. Catch both so those jumps still drive the executor.
	useEffect(() => {
		if (typeof window === 'undefined') return;
		const onHashChange = () => setHashTarget(window.location.hash);
		window.addEventListener('hashchange', onHashChange);
		window.addEventListener('popstate', onHashChange);
		return () => {
			window.removeEventListener('hashchange', onHashChange);
			window.removeEventListener('popstate', onHashChange);
		};
	}, []);

	// Execute the deep-link scroll once we have a hash target AND comments are
	// loaded AND Virtuoso has its scroll parent. Re-runs as rows stream in
	// (`comments`) and when the hash changes (`hashTarget`). Decoupling the
	// intent (hashTarget) from execution is what makes this survive a fresh
	// cross-page mount, StrictMode's double-invoke, comment caching, and refetch.
	useEffect(() => {
		if (!comments || comments.length === 0) return;
		if (!scrollParent) return;
		if (typeof window === 'undefined') return;

		const { idx, highlightId } = resolveHashTarget(hashTarget, comments);
		// Nothing to jump to, or we already handled this exact hash. The dedupe
		// guard stops a WebSocket comments refetch (fresh array reference, same
		// consumed hash) from re-yanking the viewport while the user reads.
		if (idx < 0 || lastScrolledHashRef.current === hashTarget) return;

		const consumedHash = hashTarget;
		const timers: ReturnType<typeof setTimeout>[] = [];
		// Headroom left above the landed comment: matches the rows' `scroll-mt-20`
		// (scroll-margin-top: 80px) that `scrollIntoView({ block: 'start' })`
		// honours, and the wake-the-list pre-scroll below.
		const HEADROOM = 80;
		let settled = false;

		// The live DOM node we're aiming at: the highlighted comment, or the
		// unresolved setup-repo card for `#setup-repo` (which has no highlight).
		const targetEl = (): HTMLElement | null =>
			highlightId
				? document.getElementById(`comment-${highlightId}`)
				: (listContainerRef.current?.querySelector<HTMLElement>('[data-setup-repo-anchor]') ??
					null);

		// Stop re-anchoring and consume the hash. Runs once — on natural settle or
		// the moment the user takes over scrolling. Aborting the signal removes the
		// input listeners; stripping the hash keeps a reload from re-jumping. The
		// `__root` shell no longer resets scroll on a hash-only change, so this
		// replaceState can't bounce the viewport to the top.
		const inputAbort = new AbortController();
		const finish = () => {
			if (settled) return;
			settled = true;
			for (const t of timers) clearTimeout(t);
			inputAbort.abort();
			if (window.location.hash === consumedHash) {
				window.history.replaceState(null, '', window.location.pathname + window.location.search);
			}
		};

		// Never fight the user: the first real scroll *intent* aborts the
		// re-anchor loop. Listen for input events (wheel / touch / scroll keys),
		// NOT `scroll` — our own programmatic scrolls and Virtuoso's height
		// adjustments fire `scroll` too and must not self-abort.
		const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' ']);
		const isEditable = (t: EventTarget | null): boolean =>
			t instanceof HTMLElement &&
			(t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
		scrollParent.addEventListener('wheel', finish, { passive: true, signal: inputAbort.signal });
		scrollParent.addEventListener('touchmove', finish, {
			passive: true,
			signal: inputAbort.signal,
		});
		window.addEventListener(
			'keydown',
			(e) => {
				if (!isEditable(e.target) && SCROLL_KEYS.has(e.key)) finish();
			},
			{ signal: inputAbort.signal },
		);

		// Virtuoso with `customScrollParent` only mounts items once its container
		// intersects the parent's viewport. On a fresh task page the comments list
		// starts far below the fold, so its IntersectionObserver never fires, no
		// row exists in the DOM, and `scrollToIndex` has nothing to land on. Scroll
		// the list container into view first to wake it and start mounting rows.
		if (listContainerRef.current) {
			const listTop = listContainerRef.current.getBoundingClientRect().top;
			const parentTop = scrollParent.getBoundingClientRect().top;
			const offset = scrollParent.scrollTop + listTop - parentTop;
			scrollParent.scrollTo({ top: Math.max(0, offset - HEADROOM), behavior: 'auto' });
		}

		// Re-anchor the target to the TOP of the viewport (not centred), absorbing
		// post-mount height growth (LazyMount run comments, async log bodies) that
		// would otherwise leave a single scroll short. Each tick mounts the row via
		// Virtuoso (`align: 'start'`), then fine-tunes against its real rendered
		// position; `scroll-mt-20` provides the 80px headroom. The loop self-
		// terminates once the row has held its spot for two consecutive ticks, or
		// when the budget runs out — so it doesn't keep yanking the viewport.
		//
		// Mark the hash consumed inside the FIRST tick, not now: React StrictMode
		// runs setup -> cleanup -> setup synchronously and the cleanup aborts this
		// run before the first tick fires. Setting the ref now would make the
		// second setup's `=== hashTarget` guard skip the re-arm and nothing would
		// scroll; deferring it lets the surviving setup re-arm and land the scroll.
		const scrollDelays = [16, 150, 400, 800, 1500];
		let landedStreak = 0;
		const step = (attempt: number) => {
			if (settled) return;
			if (attempt === 0) lastScrolledHashRef.current = consumedHash;
			virtuosoRef.current?.scrollToIndex({ index: idx, align: 'start' });
			const el = targetEl();
			el?.scrollIntoView({ block: 'start', behavior: 'auto' });

			const top = el
				? el.getBoundingClientRect().top - scrollParent.getBoundingClientRect().top
				: null;
			landedStreak = top !== null && Math.abs(top - HEADROOM) <= 8 ? landedStreak + 1 : 0;

			if (landedStreak >= 2 || attempt >= scrollDelays.length - 1) {
				finish();
				return;
			}
			timers.push(setTimeout(() => step(attempt + 1), scrollDelays[attempt + 1]));
		};
		timers.push(setTimeout(() => step(0), scrollDelays[0]));

		if (highlightId) setHighlightedCommentId(highlightId);

		return () => {
			inputAbort.abort();
			for (const t of timers) clearTimeout(t);
		};
	}, [comments, scrollParent, hashTarget]);

	// Fade the deep-link highlight a couple seconds after it lands. Keyed on the
	// highlighted id (not the scroll timers) so a comments refetch mid-scroll
	// can't cancel the fade and strand the ring on screen.
	useEffect(() => {
		if (!highlightedCommentId) return;
		const t = setTimeout(() => setHighlightedCommentId(null), 5000);
		return () => clearTimeout(t);
	}, [highlightedCommentId]);

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
						const isHighlighted = highlightedCommentId === c.public_id;

						if (isInlineEventType(c.content_type)) {
							const Icon = inlineEventIcon(commentData);
							return (
								<div
									id={`comment-${c.public_id}`}
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
											retryableRunId={retryableRunId}
											inline
										/>
									</div>
								</div>
							);
						}

						return (
							<div
								id={`comment-${c.public_id}`}
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
										<CommentTimestampLink publicId={c.public_id} createdAt={c.created_at} />
										<div className="ml-auto flex items-center gap-2">
											{c.parent_comment_id &&
												(() => {
													const parent = comments?.find((x) => x.id === c.parent_comment_id);
													if (!parent) return null;
													return (
														<a
															href={`#comment-${parent.public_id}`}
															onClick={jumpToComment(parent.public_id)}
															className="flex items-center gap-1 text-[11px] text-text-subtle hover:text-text"
															data-testid="replying-to"
														>
															<CornerDownRight className="w-3 h-3" />
															replying to {parent.author_name}
														</a>
													);
												})()}
											{c.content_type === CommentContentType.Text && (
												<CopyCommentButton text={commentText(c.content)} />
											)}
										</div>
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
											retryableRunId={retryableRunId}
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
												className="mt-2 flex items-center gap-1 text-[11px] text-text-subtle hover:text-text shrink-0 p-1 -m-1"
												aria-label="Reply to comment"
												data-testid="comment-reply"
											>
												<Reply className="w-3.5 h-3.5" />
												Reply
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
