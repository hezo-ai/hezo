import {
	buildThreadItems,
	findGroupKeyForRow,
	isWorkingThreadRow,
	type TaskView,
	type ThreadFoldContext,
} from '@hezo/shared';
import { useLocation } from '@tanstack/react-router';
import {
	Fragment,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { useAdminMentions, useMarkMentionRead } from '../../hooks/use-admin-mentions';
import { useAgentLookup } from '../../hooks/use-agent-lookup';
import {
	type Comment,
	type CommentSkeleton,
	ensureCommentBodies,
	skeletonNeedsBody,
	useCommentSkeletons,
} from '../../hooks/use-comments';
import type { Task } from '../../hooks/use-tasks';
import { useI18n } from '../../lib/i18n';
import { CommentRow } from './comment-row';
import { EventGroupRow } from './event-group-row';

/** How long the thread must stop scrolling before we load the bodies now on
 *  screen. A fast fling never pauses this long, so it fetches nothing. */
const DWELL_MS = 170;

type HashScrollTarget = { commentId: string | null; highlightId: string | null };

/**
 * Resolve a '#'-prefixed hash to a comment in the loaded thread.
 * `#comment-<id>` targets that comment (and highlights it); `#setup-repo`
 * targets the unresolved setup-repo action card. `commentId` is null when the
 * hash points at nothing here - no jump hash, or the row hasn't loaded yet.
 *
 * Deliberately a comment id rather than a row index: in the Conversation view
 * the rendered rows are the *folded* model, so an index into the raw thread
 * would address a different row (or none at all).
 */
function resolveHashTarget(hash: string, comments: CommentSkeleton[]): HashScrollTarget {
	if (hash.startsWith('#comment-')) {
		const targetId = hash.slice('#comment-'.length);
		// Match by public_id (the canonical anchor) first, but also accept a raw
		// UUID so legacy/internal jump hashes still resolve. Normalize the
		// highlight id back to the matched comment's public_id, which is what the
		// DOM anchor uses.
		const match = comments.find((c) => c.public_id === targetId || c.id === targetId);
		return { commentId: match?.id ?? null, highlightId: match?.public_id ?? null };
	}
	if (hash === '#setup-repo') {
		const match = comments.find((c) => {
			if (c.content_type !== 'action') return false;
			const content = typeof c.content === 'object' ? (c.content as { kind?: string }) : null;
			return content?.kind === 'setup_repo' && !c.chosen_option;
		});
		return { commentId: match?.id ?? null, highlightId: null };
	}
	return { commentId: null, highlightId: null };
}

interface CommentsSectionProps {
	task: Task;
	projectId: string;
	taskId: string;
	taskProjectSlug: string;
	scrollParent: HTMLElement | null;
	onStartReply: (comment: Comment) => void;
	/** Which rows the reader sees. Detailed renders every row, as it always has. */
	view: TaskView;
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
	view,
}: CommentsSectionProps) {
	const { plural } = useI18n();
	const { data: comments } = useCommentSkeletons(projectId, taskId);
	const skeletonById = useMemo(() => {
		const m = new Map<string, CommentSkeleton>();
		for (const c of comments ?? []) m.set(c.id, c);
		return m;
	}, [comments]);

	// --- Lazy body loading on scroll-dwell ---
	// The feed renders placeholders for every row up front; a row's body is fetched
	// (batched by id) only once the thread *settles* on it. During a fast scroll the
	// settle timer keeps resetting and never fires, so flinging past a section loads
	// nothing — bodies load when the user stops or scrolls slowly enough to read.
	const isScrollingRef = useRef(false);
	const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const skeletonByIdRef = useRef(skeletonById);
	skeletonByIdRef.current = skeletonById;
	const loadVisibleBodies = useCallback(() => {
		const ids: string[] = [];
		for (const commentId of visibleCommentsRef.current) {
			const c = skeletonByIdRef.current.get(commentId);
			if (c && skeletonNeedsBody(c)) ids.push(commentId);
		}
		if (ids.length) ensureCommentBodies(projectId, taskId, ids);
	}, [projectId, taskId]);
	// Debounce a load so a burst of intersection callbacks coalesces into one flush.
	const scheduleBodyFlush = useCallback(() => {
		if (isScrollingRef.current) return;
		if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
		flushTimerRef.current = setTimeout(loadVisibleBodies, 60);
	}, [loadVisibleBodies]);
	const scheduleBodyFlushRef = useRef(scheduleBodyFlush);
	scheduleBodyFlushRef.current = scheduleBodyFlush;

	// --- Mark a pending @admin inbox notification read once its comment is seen ---
	// A notification stays unread until the user actually views its comment. Only
	// fetch the caller's mentions when this task has an unread one (a server-
	// computed flag on the task), so ordinary task views make no extra request.
	// Marking reuses the inbox card's mutation and is idempotent server-side, so
	// the two paths never conflict.
	const { data: adminMentions } = useAdminMentions(taskProjectSlug, task.has_unread_admin_mention);
	const markMentionRead = useMarkMentionRead();
	const markMentionReadRef = useRef(markMentionRead);
	markMentionReadRef.current = markMentionRead;
	// comment_id (a globally-unique UUID) -> mentionId for the caller's UNREAD
	// mentions. public_id can't key this — it's only unique within one task.
	const pendingMentionByCommentId = useMemo(() => {
		const map = new Map<string, string>();
		for (const mention of adminMentions ?? []) {
			if (!mention.read_at) map.set(mention.comment_id, mention.id);
		}
		return map;
	}, [adminMentions]);
	// Fires once per comment, at most once (markedCommentsRef), and never while the
	// tab is hidden. Reads the latest pending map, so a mention that loads after
	// its comment is already on screen still marks it.
	const markedCommentsRef = useRef<Set<string>>(new Set());
	const markCommentReadIfPending = useCallback(
		(commentId: string) => {
			if (markedCommentsRef.current.has(commentId)) return;
			const mentionId = pendingMentionByCommentId.get(commentId);
			if (!mentionId) return;
			if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
			markedCommentsRef.current.add(commentId);
			markMentionReadRef.current.mutate({ projectSlug: taskProjectSlug, mentionId });
		},
		[pendingMentionByCommentId, taskProjectSlug],
	);
	// Stable handle to the latest marker for the (scroll-parent-stable) observer.
	const markHandlerRef = useRef(markCommentReadIfPending);
	markHandlerRef.current = markCommentReadIfPending;
	// One IntersectionObserver over the thread's scroll parent is the source of
	// truth for "seen": Virtuoso's 600px overscan mounts rows before they're
	// visible, so mounting alone is not a view — only real viewport intersection.
	const observerRef = useRef<IntersectionObserver | null>(null);
	const mountedRowsRef = useRef<Map<string, HTMLElement>>(new Map());
	const visibleCommentsRef = useRef<Set<string>>(new Set());
	const observeCommentRow = useCallback((el: HTMLDivElement | null) => {
		if (!el) return;
		const commentId = el.dataset.commentId;
		if (!commentId) return;
		mountedRowsRef.current.set(commentId, el);
		observerRef.current?.observe(el);
		return () => {
			observerRef.current?.unobserve(el);
			mountedRowsRef.current.delete(commentId);
			visibleCommentsRef.current.delete(commentId);
		};
	}, []);
	useEffect(() => {
		if (typeof IntersectionObserver === 'undefined') return;
		const io = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const commentId = (entry.target as HTMLElement).dataset.commentId;
					if (!commentId) continue;
					if (entry.isIntersecting) {
						visibleCommentsRef.current.add(commentId);
						markHandlerRef.current(commentId);
					} else {
						visibleCommentsRef.current.delete(commentId);
					}
				}
				// The visible set changed; load the on-screen bodies once bursts settle
				// (skipped mid-scroll, so a fling loads nothing).
				scheduleBodyFlushRef.current();
			},
			{ root: scrollParent ?? null },
		);
		observerRef.current = io;
		// Observe rows that mounted before the observer existed (first paint, or a
		// scroll-parent swap once <main> resolves).
		for (const el of mountedRowsRef.current.values()) io.observe(el);
		return () => {
			io.disconnect();
			observerRef.current = null;
			visibleCommentsRef.current.clear();
		};
	}, [scrollParent]);

	// Scroll-dwell gate. While the parent is actively scrolling we suppress body
	// loads; DWELL_MS after the last scroll event we mark it settled and load the
	// rows that ended up on screen. A continuous fast fling never pauses long
	// enough to fire, so it fetches nothing until the user stops.
	useEffect(() => {
		if (!scrollParent) return;
		const onScroll = () => {
			isScrollingRef.current = true;
			if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
			if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
			settleTimerRef.current = setTimeout(() => {
				isScrollingRef.current = false;
				loadVisibleBodies();
			}, DWELL_MS);
		};
		scrollParent.addEventListener('scroll', onScroll, { passive: true });
		return () => {
			scrollParent.removeEventListener('scroll', onScroll);
			if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
			if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
		};
	}, [scrollParent, loadVisibleBodies]);
	// Both the comments and the mentions load asynchronously (and the stubbed
	// observer in component tests fires on observe, before mentions resolve), so a
	// mention can arrive after its comment is already visible. Re-check the
	// on-screen rows whenever the pending set changes.
	useEffect(() => {
		for (const commentId of visibleCommentsRef.current) markCommentReadIfPending(commentId);
	}, [markCommentReadIfPending]);

	// Resolve agent comment authors to the full roster entry, so the avatar + name
	// link to the agent's page and carry the identity hover card. Reads the
	// already-cached team roster; cross-team authors (CEO / Coach) aren't in it
	// and stay unlinked.
	const { byMemberId: agentsByMemberId } = useAgentLookup(projectId);
	// The run_id whose failed run-entry comment may show a Retry button: the most
	// recent run referenced in the thread, and only when no run is currently
	// active or queued. Run comments (any outcome) and run_failed comments both
	// carry a run_id; comments arrive oldest-first, so the last match is the
	// newest run. Older failed runs — superseded by a later run, or any run while
	// one is active/queued — resolve to a different id (or null) and hide their
	// Retry button.
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
	// The rows a reader actually sees. In Conversation, contiguous foldable rows
	// collapse into groups; in Detailed every row comes back on its own, so the
	// two views are one feed rather than two.
	const foldCtx = useMemo<ThreadFoldContext>(
		() => ({ activeRunId: task.active_run?.id ?? null, retryableRunId }),
		[task.active_run?.id, retryableRunId],
	);
	const items = useMemo(
		() => buildThreadItems(comments ?? [], view, foldCtx),
		[comments, view, foldCtx],
	);
	// Group keys are derived from their first row's id, so an expanded group keeps
	// its state across a refetch and as later events join it.
	const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
	const toggleGroup = useCallback((key: string) => {
		setExpandedGroups((prev) => {
			const next = new Set(prev);
			if (!next.delete(key)) next.add(key);
			return next;
		});
	}, []);

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

		const { commentId, highlightId } = resolveHashTarget(hashTarget, comments);
		// Nothing to jump to, or we already handled this exact hash. The dedupe
		// guard stops a WebSocket comments refetch (fresh array reference, same
		// consumed hash) from re-yanking the viewport while the user reads.
		if (!commentId || lastScrolledHashRef.current === hashTarget) return;

		// A deep link can land inside a folded group, whose rows are not in the DOM
		// while it is collapsed. Expand it first and let this effect re-run - the
		// hash is not marked consumed yet, so the scroll happens on the next pass
		// with the target mounted.
		const groupKey = findGroupKeyForRow(items, commentId);
		if (groupKey && !expandedGroups.has(groupKey)) {
			toggleGroup(groupKey);
			return;
		}

		// Index into the rendered rows: the row itself, or the group holding it.
		const idx = items.findIndex((item) =>
			item.kind === 'row' ? item.row.id === commentId : item.key === groupKey,
		);
		if (idx < 0) return;

		// A deep link jumps straight to a row the user hasn't dwelled on, so load its
		// body eagerly — otherwise the placeholder→body height change lands mid-anchor
		// and shifts the target out from under the viewport.
		const target = comments.find((c) => c.id === commentId);
		if (target && skeletonNeedsBody(target)) ensureCommentBodies(projectId, taskId, [target.id]);

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
	}, [comments, scrollParent, hashTarget, projectId, taskId, items, expandedGroups, toggleGroup]);

	// Fade the deep-link highlight a couple seconds after it lands. Keyed on the
	// highlighted id (not the scroll timers) so a comments refetch mid-scroll
	// can't cancel the fade and strand the ring on screen.
	useEffect(() => {
		if (!highlightedCommentId) return;
		const t = setTimeout(() => setHighlightedCommentId(null), 5000);
		return () => clearTimeout(t);
	}, [highlightedCommentId]);

	const renderComment = (c: CommentSkeleton) => (
		<CommentRow
			comment={c}
			comments={comments ?? []}
			projectId={projectId}
			taskProjectSlug={taskProjectSlug}
			taskId={taskId}
			retryableRunId={retryableRunId}
			isHighlighted={highlightedCommentId === c.public_id}
			agentsByMemberId={agentsByMemberId}
			observeCommentRow={observeCommentRow}
			onStartReply={onStartReply}
			working={isWorkingThreadRow(c, foldCtx)}
		/>
	);

	// The badge counts what it says it counts: the rows on screen, with the folded
	// ones tallied beside it. Counting here rather than in the route is what keeps
	// the two numbers and the feed reading from one row model.
	const visibleCount = items.filter((i) => i.kind === 'row').length;
	const foldedCount = (comments?.length ?? 0) - visibleCount;

	return (
		<div ref={listContainerRef} className="mb-4" data-testid="comments-list">
			<div className="flex items-center gap-1.5 mb-4">
				<h3 className="text-[13px] text-text-1 font-medium">Comments</h3>
				<span
					className="bg-surface-2 px-[7px] py-px rounded-full text-[11px] text-text-2"
					data-testid="thread-comment-count"
				>
					{visibleCount}
				</span>
				{foldedCount > 0 && (
					<span className="text-[11px] text-text-3" data-testid="thread-folded-count">
						{`+ ${plural('thread.group.events', foldedCount)}`}
					</span>
				)}
			</div>
			{scrollParent && (
				<Virtuoso
					ref={virtuosoRef}
					customScrollParent={scrollParent}
					data={items}
					computeItemKey={(_, item) => item.key}
					defaultItemHeight={120}
					increaseViewportBy={{ top: 600, bottom: 600 }}
					itemContent={(_, item) =>
						item.kind === 'row' ? (
							renderComment(item.row)
						) : (
							<EventGroupRow
								summary={item.summary}
								expanded={expandedGroups.has(item.key)}
								onToggle={() => toggleGroup(item.key)}
							>
								{item.rows.map((row) => (
									<Fragment key={row.id}>{renderComment(row)}</Fragment>
								))}
							</EventGroupRow>
						)
					}
				/>
			)}
		</div>
	);
}
