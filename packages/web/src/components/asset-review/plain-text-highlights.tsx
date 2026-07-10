import { useMemo } from 'react';
import { findQuoteRange, type ReviewAnnotation } from '../../lib/rehype-review-highlights';
import { REVIEW_MARK_ACTIVE_CLASSES, REVIEW_MARK_CLASSES } from '../markdown-prose';

interface Segment {
	text: string;
	/** The annotation this segment is highlighted for; undefined = plain text. */
	reviewId?: string;
}

/**
 * Resolve quote/occurrence anchors against the raw string, mirroring
 * `applyReviewHighlights`' claim semantics: earlier annotations win, an
 * overlapping later match is dropped.
 */
function computeSegments(content: string, annotations: ReviewAnnotation[]): Segment[] {
	const claimed: Array<{ start: number; end: number; id: string }> = [];
	for (const ann of annotations) {
		const range = findQuoteRange(content, ann.quote, ann.occurrence);
		if (!range) continue;
		if (claimed.some((c) => range.start < c.end && c.start < range.end)) continue;
		claimed.push({ ...range, id: ann.id });
	}
	claimed.sort((a, b) => a.start - b.start);

	const segments: Segment[] = [];
	let cursor = 0;
	for (const c of claimed) {
		if (c.start > cursor) segments.push({ text: content.slice(cursor, c.start) });
		segments.push({ text: content.slice(c.start, c.end), reviewId: c.id });
		cursor = c.end;
	}
	if (cursor < content.length) segments.push({ text: content.slice(cursor) });
	return segments;
}

interface PlainTextWithHighlightsProps {
	content: string;
	annotations: ReviewAnnotation[];
	activeId: string | null;
	onHighlightClick: (id: string) => void;
}

/**
 * A plain-text asset body with review highlights: the string renders inside a
 * `<pre>`, quote anchors wrapped in the same clickable `mark[data-review-id]`
 * the markdown surface produces. The pre's DOM text stream is byte-identical
 * to the source string, so `computeSelectionAnchor` resolves selections
 * against it exactly as it does for rendered markdown.
 */
export function PlainTextWithHighlights({
	content,
	annotations,
	activeId,
	onHighlightClick,
}: PlainTextWithHighlightsProps) {
	const segments = useMemo(() => computeSegments(content, annotations), [content, annotations]);
	return (
		<pre
			data-testid="asset-plain-text"
			className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-text-1"
		>
			{segments.map((seg, i) =>
				seg.reviewId ? (
					// biome-ignore lint/a11y/useSemanticElements: a <button> cannot wrap arbitrary inline pre text; the mark carries role/tabIndex/keydown instead (same pattern as markdown-prose)
					<mark
						// biome-ignore lint/suspicious/noArrayIndexKey: segments are a pure slicing of `content` — stable for a given (content, annotations)
						key={i}
						data-review-id={seg.reviewId}
						data-testid="review-highlight"
						className={seg.reviewId === activeId ? REVIEW_MARK_ACTIVE_CLASSES : REVIEW_MARK_CLASSES}
						onClick={() => onHighlightClick(seg.reviewId as string)}
						onKeyDown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								onHighlightClick(seg.reviewId as string);
							}
						}}
						// biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: the highlight is genuinely interactive (opens its comment editor); full keyboard support is provided
						role="button"
						tabIndex={0}
					>
						{seg.text}
					</mark>
				) : (
					seg.text
				),
			)}
		</pre>
	);
}
