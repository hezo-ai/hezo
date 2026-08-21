import { ChevronRight } from 'lucide-react';
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from 'react';

export interface BreadcrumbSegment {
	key: string;
	label: ReactNode;
	/** Full text for the title attribute, for the widths where the row overflows. */
	title?: string;
	/** Navigation for non-leaf segments; the last segment never navigates. */
	onNavigate?: () => void;
}

/** Which edges have more row beyond them, so only those get a fade. */
interface EdgeState {
	left: boolean;
	right: boolean;
}

/** How far from an edge still counts as "at" it, in px. */
const EDGE_EPSILON = 1;

function readEdges(el: HTMLElement): EdgeState {
	const max = el.scrollWidth - el.clientWidth;
	if (max <= EDGE_EPSILON) return { left: false, right: false };
	return {
		left: el.scrollLeft > EDGE_EPSILON,
		right: el.scrollLeft < max - EDGE_EPSILON,
	};
}

/**
 * A breadcrumb row: one line at every width, scrolling sideways rather than
 * wrapping or truncating, so the whole trail stays reachable on the narrowest
 * phone. This is the only home for that behaviour - `Breadcrumb` below, the task
 * header's sticky crumb and the marketplace crumb all render through it, so a
 * change to how a crumb overflows lands in one place.
 *
 * Callers bring their own children and their own positioning via `className`
 * (the task crumb's sticky band, for instance); everything about the overflow
 * belongs here. Children must be `shrink-0` and `whitespace-nowrap` - a segment
 * that gives way defeats the scroller.
 *
 * `anchor="end"` starts the row at the current item, which is what a reader on a
 * phone wants to see, and re-anchors when the row grows (the task crumb picks up
 * the task name once the heading scrolls away). It backs off the moment the
 * reader scrolls the row themselves.
 */
export function BreadcrumbRow({
	children,
	className = '',
	anchor = 'end',
	ref: externalRef,
	'aria-label': ariaLabel = 'Breadcrumb',
	'data-testid': testId,
	'data-pinned': dataPinned,
}: {
	children: ReactNode;
	className?: string;
	anchor?: 'start' | 'end';
	/** Object ref onto the row itself, for a caller that measures the band it occupies. */
	ref?: RefObject<HTMLElement | null>;
	'aria-label'?: string;
	'data-testid'?: string;
	'data-pinned'?: string;
}) {
	const ownRef = useRef<HTMLElement>(null);
	const ref = externalRef ?? ownRef;
	// The row's content, sized to itself (`w-max`) so the nav has something to
	// scroll. Watching one stable element rather than the children means a segment
	// appearing, a name changing or a font landing all report the same way.
	const contentRef = useRef<HTMLDivElement>(null);
	const [edges, setEdges] = useState<EdgeState>({ left: false, right: false });
	// Set around our own scrollLeft writes so the scroll handler they fire is not
	// mistaken for the reader taking over.
	const programmatic = useRef(false);
	const readerScrolled = useRef(false);
	// The width we last anchored at, so a re-render that changes nothing does not
	// yank a row the reader is part-way through.
	const anchoredWidth = useRef(0);

	const syncEdges = useCallback(() => {
		const el = ref.current;
		if (!el) return;
		setEdges((prev) => {
			const next = readEdges(el);
			return prev.left === next.left && prev.right === next.right ? prev : next;
		});
	}, [ref]);

	const onScroll = useCallback(() => {
		if (!programmatic.current) readerScrolled.current = true;
		syncEdges();
	}, [syncEdges]);

	useEffect(() => {
		const el = ref.current;
		const content = contentRef.current;
		if (!el || !content) return;

		const toEnd = () => {
			programmatic.current = true;
			el.scrollLeft = el.scrollWidth;
			// The scroll event is dispatched asynchronously, so the flag has to
			// outlive this frame.
			requestAnimationFrame(() => {
				programmatic.current = false;
			});
		};

		const settle = () => {
			if (anchor === 'end' && !readerScrolled.current && el.scrollWidth > anchoredWidth.current) {
				anchoredWidth.current = el.scrollWidth;
				toEnd();
			}
			syncEdges();
		};

		settle();
		// happy-dom runs no layout, so it never reports an overflow to observe; the
		// browser spec covers the scrolling. Guarded the way LazyMount guards its own.
		if (typeof ResizeObserver === 'undefined') return;
		// The nav for the width available, the content for the width wanted.
		const ro = new ResizeObserver(settle);
		ro.observe(el);
		ro.observe(content);
		return () => ro.disconnect();
	}, [anchor, ref, syncEdges]);

	// Only fade an edge that has something behind it - a row that fits is untouched,
	// and the mask itself lives in `index.css` beside the `.breadcrumb-row` class.
	const overflow = edges.left ? (edges.right ? 'both' : 'left') : edges.right ? 'right' : undefined;

	return (
		<nav
			ref={ref}
			aria-label={ariaLabel}
			onScroll={onScroll}
			data-testid={testId}
			data-pinned={dataPinned}
			data-overflow={overflow}
			// `overflow-y-hidden` is deliberate: `overflow-x-auto` alone computes the
			// other axis to `auto` too, which would hand this single line a vertical
			// scrollbar of its own. `overscroll-x-contain` keeps a sideways swipe off
			// the browser's back gesture. `min-w-0` is what lets the row scroll rather
			// than push its parent wide when a caller drops it into a flex container.
			className={`breadcrumb-row min-w-0 overflow-x-auto overflow-y-hidden overscroll-x-contain scrollbar-none ${className}`}
		>
			<div ref={contentRef} className="flex w-max items-center gap-x-1" data-breadcrumb-content="">
				{children}
			</div>
		</nav>
	);
}

/**
 * The task/goal-header breadcrumb idiom as a shared primitive: a mono 13px
 * row with ChevronRight separators and `aria-current="page"` on the leaf.
 * Non-leaf segments navigate via callback so callers can drive route params
 * or search params alike.
 */
export function Breadcrumb({
	segments,
	'data-testid': testId,
}: {
	segments: BreadcrumbSegment[];
	'data-testid'?: string;
}) {
	return (
		<BreadcrumbRow className="text-[13px] font-mono text-text-2" data-testid={testId}>
			{segments.map((seg, i) =>
				i < segments.length - 1 ? (
					<span key={seg.key} className="flex shrink-0 items-center gap-x-1 whitespace-nowrap">
						<button
							type="button"
							onClick={seg.onNavigate}
							className="cursor-pointer transition-colors hover:text-text-1 hover:underline"
							title={seg.title}
						>
							{seg.label}
						</button>
						<ChevronRight className="h-3 w-3 shrink-0 text-text-3" />
					</span>
				) : (
					<span
						key={seg.key}
						aria-current="page"
						className="shrink-0 whitespace-nowrap text-text-1"
						title={seg.title}
					>
						{seg.label}
					</span>
				),
			)}
		</BreadcrumbRow>
	);
}
