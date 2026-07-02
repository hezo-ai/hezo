import { MessageSquare, MessageSquarePlus } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
	type DocReviewComment,
	useCreateDocReviewComment,
	useDeleteDocReviewComment,
	useDocReviewComments,
	useUpdateDocReviewComment,
} from '../../hooks/use-doc-review';
import { toast } from '../../hooks/use-toast';
import {
	computeBlockAnchor,
	computeSelectionAnchor,
	type ReviewAnchor,
} from '../../lib/doc-review-selection';
import type { ReviewAnnotation } from '../../lib/rehype-review-highlights';
import { MarkdownProse } from '../markdown-prose';
import { Button } from '../ui/button';

interface ReviewableDocumentProps {
	/** Route-param project slug (query keys + API paths). */
	projectId: string;
	projectSlug: string;
	filename: string;
	content: string;
	/** The document `updated_at` this view rendered — guards stale creates. */
	docUpdatedAt?: string;
}

interface DraftState {
	anchor: ReviewAnchor;
	top: number;
}

interface SelectionState {
	anchor: ReviewAnchor;
	top: number;
	left: number;
}

interface HoverLineState {
	block: HTMLElement;
	top: number;
	height: number;
}

interface IconEntry {
	id: string;
	top: number;
	matched: boolean;
}

const ICON_STACK_GAP = 28;
const HOVER_BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, pre, blockquote';

/**
 * A project document rendered in view mode with review-comment support:
 * selecting text raises a floating "Comment" pill; hovering a line (pointer
 * devices) raises a ghost icon in the right margin that comments on the whole
 * line; saved comments render as persistent highlights with Google-Docs-style
 * margin icons that scroll with the content. Comments are DB-backed and
 * version-scoped — any edit to the document wipes them (see the ? help).
 */
export function ReviewableDocument({
	projectId,
	projectSlug,
	filename,
	content,
	docUpdatedAt,
}: ReviewableDocumentProps) {
	const wrapperRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);

	const { data: comments } = useDocReviewComments(projectId, filename);
	const create = useCreateDocReviewComment(projectId, filename);
	const update = useUpdateDocReviewComment(projectId, filename);
	const remove = useDeleteDocReviewComment(projectId, filename);

	const [activeId, setActiveId] = useState<string | null>(null);
	const [draft, setDraft] = useState<DraftState | null>(null);
	const [selection, setSelection] = useState<SelectionState | null>(null);
	const [hoverLine, setHoverLine] = useState<HoverLineState | null>(null);
	const [iconLayout, setIconLayout] = useState<IconEntry[]>([]);
	const isDesktopEditor = useMediaQuery('(min-width: 640px)');
	// Hover-a-line is pointless on touch devices (no hover): text selection is
	// the mobile affordance. Gate on "not coarse" rather than "fine" so pointer
	// devices that report neither still get the hover path.
	const pointerCoarse = useMediaQuery('(pointer: coarse)');

	const annotations = useMemo<ReviewAnnotation[]>(
		() => (comments ?? []).map((c) => ({ id: c.id, quote: c.quote, occurrence: c.occurrence })),
		[comments],
	);
	const activeComment: DocReviewComment | null =
		(activeId ? comments?.find((c) => c.id === activeId) : null) ?? null;
	const editorOpen = draft !== null || activeComment !== null;

	const openExisting = useCallback((id: string) => {
		setDraft(null);
		setSelection(null);
		setHoverLine(null);
		setActiveId(id);
	}, []);

	function closeEditor() {
		setDraft(null);
		setActiveId(null);
	}

	// ---- selection capture → floating "Comment" pill --------------------------
	useEffect(() => {
		const doc = wrapperRef.current?.ownerDocument ?? document;
		let raf = 0;
		const onSelectionChange = () => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(() => {
				const wrapper = wrapperRef.current;
				const contentEl = contentRef.current;
				if (!wrapper || !contentEl) return;
				const sel = doc.getSelection();
				if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
					setSelection(null);
					return;
				}
				const range = sel.getRangeAt(0);
				const anchor = computeSelectionAnchor(contentEl, range);
				if (!anchor || selectionIntersectsMark(contentEl, range)) {
					setSelection(null);
					return;
				}
				const wRect = wrapper.getBoundingClientRect();
				const rects = range.getClientRects();
				const last = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
				const left = Math.max(8, Math.min(last.right - wRect.left - 36, wrapper.clientWidth - 130));
				setSelection({ anchor, top: last.bottom - wRect.top + 6, left });
			});
		};
		doc.addEventListener('selectionchange', onSelectionChange);
		return () => {
			doc.removeEventListener('selectionchange', onSelectionChange);
			cancelAnimationFrame(raf);
		};
	}, []);

	function startDraftFromSelection() {
		if (!selection) return;
		setActiveId(null);
		setDraft({ anchor: selection.anchor, top: selection.top });
		setSelection(null);
		wrapperRef.current?.ownerDocument.getSelection()?.removeAllRanges();
	}

	// ---- hover-a-line ghost icon (pointer devices only) ------------------------
	function handleContentMouseOver(e: React.MouseEvent) {
		if (pointerCoarse) return;
		const wrapper = wrapperRef.current;
		const contentEl = contentRef.current;
		if (!wrapper || !contentEl) return;
		const target = e.target as Element;
		const block = target.closest?.(HOVER_BLOCK_SELECTOR);
		if (!block || !contentEl.contains(block)) return;
		const wRect = wrapper.getBoundingClientRect();
		const bRect = block.getBoundingClientRect();
		setHoverLine((prev) =>
			prev?.block === block
				? prev
				: { block: block as HTMLElement, top: bRect.top - wRect.top, height: bRect.height },
		);
	}

	function handleGhostClick() {
		const contentEl = contentRef.current;
		if (!hoverLine || !contentEl) return;
		if (hoverLine.block.querySelector('mark[data-review-id]')) {
			toast.info('This line already has a comment');
			return;
		}
		const anchor = computeBlockAnchor(contentEl, hoverLine.block);
		if (!anchor) return;
		setActiveId(null);
		setSelection(null);
		setDraft({ anchor, top: hoverLine.top });
		setHoverLine(null);
	}

	// ---- margin icon layout ----------------------------------------------------
	// biome-ignore lint/correctness/useExhaustiveDependencies: content/activeId reposition marks
	useLayoutEffect(() => {
		const wrapper = wrapperRef.current;
		const contentEl = contentRef.current;
		if (!wrapper || !contentEl || !comments || comments.length === 0) {
			setIconLayout((prev) => (prev.length === 0 ? prev : []));
			return;
		}
		const compute = () => {
			const wRect = wrapper.getBoundingClientRect();
			const entries: IconEntry[] = comments.map((c) => {
				const mark = contentEl.querySelector(`mark[data-review-id="${c.id}"]`);
				if (!mark) return { id: c.id, top: 0, matched: false };
				return { id: c.id, top: mark.getBoundingClientRect().top - wRect.top, matched: true };
			});
			entries.sort((a, b) => a.top - b.top);
			let prev = Number.NEGATIVE_INFINITY;
			for (const entry of entries) {
				entry.top = Math.max(entry.top, 2, prev + ICON_STACK_GAP);
				prev = entry.top;
			}
			setIconLayout((current) =>
				current.length === entries.length &&
				current.every(
					(c, i) =>
						c.id === entries[i].id && c.top === entries[i].top && c.matched === entries[i].matched,
				)
					? current
					: entries,
			);
		};
		compute();
		if (typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(compute);
		observer.observe(wrapper);
		return () => observer.disconnect();
	}, [comments, content, activeId]);

	// ---- save / delete ----------------------------------------------------------
	async function handleSave(text: string) {
		if (draft) {
			try {
				await create.mutateAsync({
					quote: draft.anchor.quote,
					occurrence: draft.anchor.occurrence,
					comment: text,
					docUpdatedAt,
				});
				setDraft(null);
			} catch (e) {
				toast.error((e as Error).message || 'Failed to add comment');
			}
			return;
		}
		if (activeId) {
			update.mutate({ commentId: activeId, comment: text });
			setActiveId(null);
		}
	}

	function handleDelete() {
		if (!activeId) return;
		remove.mutate({ commentId: activeId });
		setActiveId(null);
	}

	const editorTop = draft?.top ?? iconLayout.find((e) => e.id === activeId)?.top ?? 0;

	// Memoize the rendered markdown so hover/selection/draft state changes in
	// this wrapper don't re-run react-markdown: a re-render swaps every mark's
	// DOM node, which detaches the node a click is mid-flight on (pointerover →
	// hover state → re-render → the subsequent click fires on a dead node).
	const prose = useMemo(
		() => (
			<MarkdownProse
				projectId={projectId}
				projectSlug={projectSlug}
				reviewAnnotations={annotations}
				onReviewHighlightClick={openExisting}
				activeReviewId={activeId}
			>
				{content}
			</MarkdownProse>
		),
		[projectId, projectSlug, annotations, openExisting, activeId, content],
	);

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: mouseleave only clears the pointer-hover ghost; keyboard users act through the focusable highlights and margin-icon buttons
		<div
			ref={wrapperRef}
			className="relative pr-9 sm:pr-10"
			data-testid="reviewable-document"
			onMouseLeave={() => setHoverLine(null)}
		>
			{hoverLine && !editorOpen && (
				<div
					aria-hidden
					data-testid="review-line-hover"
					className="pointer-events-none absolute -left-1.5 right-8 rounded-md bg-surface-2"
					style={{ top: hoverLine.top - 3, height: hoverLine.height + 6 }}
				/>
			)}

			{/* biome-ignore lint/a11y/noStaticElementInteractions: mouseover raises the pointer-only hover-a-line ghost; keyboard users comment via selection or the focusable highlights */}
			{/* biome-ignore lint/a11y/useKeyWithMouseEvents: same — the hover affordance has no keyboard analogue by design */}
			<div ref={contentRef} className="relative" onMouseOver={handleContentMouseOver}>
				{prose}
			</div>

			{hoverLine && !editorOpen && (
				<button
					type="button"
					aria-label="Comment on this line"
					data-testid="review-line-ghost"
					className="absolute right-0.5 flex h-6 w-6 items-center justify-center rounded-full border border-dashed border-border-strong bg-surface text-text-3 transition-colors hover:text-text-1"
					style={{ top: hoverLine.top }}
					onClick={handleGhostClick}
				>
					<MessageSquarePlus className="h-3.5 w-3.5" />
				</button>
			)}

			{iconLayout.map((entry) => (
				<button
					key={entry.id}
					type="button"
					aria-label="View review comment"
					data-testid="review-margin-icon"
					data-review-icon-id={entry.id}
					className={`absolute right-0.5 flex h-6 w-6 items-center justify-center rounded-full border shadow-xs transition-colors ${
						entry.id === activeId
							? 'border-accent-solid bg-accent-solid text-accent-solid-fg'
							: 'border-border bg-surface text-accent-soft-fg hover:bg-surface-2'
					}`}
					style={{ top: entry.top }}
					onClick={() => openExisting(entry.id)}
				>
					<MessageSquare className="h-3.5 w-3.5" />
				</button>
			))}

			{selection && !editorOpen && (
				<button
					type="button"
					data-testid="review-selection-pill"
					className="absolute z-20 inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border-strong bg-surface px-3 py-1 text-xs font-medium text-text-1 shadow-md"
					style={{ top: selection.top, left: selection.left }}
					onMouseDown={(e) => {
						// mousedown (not click): a click would first collapse the selection
						// and unmount this pill before the handler runs.
						e.preventDefault();
						startDraftFromSelection();
					}}
				>
					<MessageSquarePlus className="h-3.5 w-3.5 text-accent-soft-fg" />
					Comment
				</button>
			)}

			{editorOpen && (
				<ReviewEditor
					key={activeId ?? 'draft'}
					quote={draft?.anchor.quote ?? activeComment?.quote ?? ''}
					initialText={activeComment?.comment ?? ''}
					isNew={draft !== null}
					top={editorTop}
					desktop={isDesktopEditor}
					saving={create.isPending}
					onSave={handleSave}
					onDelete={draft ? undefined : handleDelete}
					onClose={closeEditor}
				/>
			)}
		</div>
	);
}

function selectionIntersectsMark(contentEl: HTMLElement, range: Range): boolean {
	for (const mark of contentEl.querySelectorAll('mark[data-review-id]')) {
		try {
			if (range.intersectsNode(mark)) return true;
		} catch {
			// happy-dom may not implement intersectsNode; treat as no overlap.
		}
	}
	return false;
}

function useMediaQuery(query: string): boolean {
	const [matches, setMatches] = useState(() => {
		if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
		return window.matchMedia(query).matches;
	});
	useEffect(() => {
		if (typeof window.matchMedia !== 'function') return;
		const mql = window.matchMedia(query);
		const onChange = () => setMatches(mql.matches);
		mql.addEventListener?.('change', onChange);
		setMatches(mql.matches);
		return () => mql.removeEventListener?.('change', onChange);
	}, [query]);
	return matches;
}

interface ReviewEditorProps {
	quote: string;
	initialText: string;
	isNew: boolean;
	top: number;
	desktop: boolean;
	saving: boolean;
	onSave: (text: string) => void;
	onDelete?: () => void;
	onClose: () => void;
}

/** The comment editor: popover card on ≥sm, bottom sheet below. */
function ReviewEditor({
	quote,
	initialText,
	isNew,
	top,
	desktop,
	saving,
	onSave,
	onDelete,
	onClose,
}: ReviewEditorProps) {
	const [text, setText] = useState(initialText);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		textareaRef.current?.focus();
	}, []);

	const canSave = text.trim().length > 0 && !saving;

	function handleKeyDown(e: React.KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			onClose();
		}
		if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canSave) {
			e.preventDefault();
			onSave(text);
		}
	}

	return (
		<div
			data-testid="review-editor"
			className={
				desktop
					? 'absolute right-0 z-30 w-[300px] max-w-full rounded-xl border border-border bg-surface shadow-lg'
					: 'fixed inset-x-0 bottom-0 z-[70] rounded-t-xl border-t border-border bg-surface shadow-lg'
			}
			style={desktop ? { top: Math.max(top, 2) + ICON_STACK_GAP } : undefined}
		>
			{!desktop && <div className="mx-auto mt-2 h-1 w-9 rounded-full bg-surface-3" aria-hidden />}
			<div className="px-3 pt-2.5">
				<div className="text-eyebrow mb-1.5 text-text-3">{isNew ? 'New comment' : 'Comment'}</div>
				<div
					className="truncate rounded-r border-l-2 border-accent/45 bg-accent/10 px-2 py-0.5 text-xs italic text-text-2"
					title={quote}
				>
					“{quote}”
				</div>
			</div>
			<textarea
				ref={textareaRef}
				value={text}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={handleKeyDown}
				placeholder="Leave a comment..."
				data-testid="review-editor-textarea"
				className="mx-3 mt-2.5 block h-[70px] w-[calc(100%-1.5rem)] resize-none rounded-md border border-border-strong bg-surface px-2.5 py-1.5 text-[13px] leading-snug text-text-1 outline-none focus:border-accent focus:ring-[3px] focus:ring-ring"
			/>
			<div className="flex items-center justify-between px-3 pb-3 pt-2.5">
				{onDelete ? (
					<Button
						variant="danger-text"
						size="sm"
						onClick={onDelete}
						data-testid="review-editor-delete"
					>
						Delete
					</Button>
				) : (
					<span />
				)}
				<div className="flex items-center gap-1.5">
					<Button variant="ghost" size="sm" onClick={onClose} data-testid="review-editor-cancel">
						Cancel
					</Button>
					<Button
						variant="primary"
						size="sm"
						disabled={!canSave}
						onClick={() => onSave(text)}
						data-testid="review-editor-save"
					>
						Save
					</Button>
				</div>
			</div>
		</div>
	);
}
