import type { MatchRange } from '../../lib/rehype-review-highlights';
import { REVIEW_MARK_ACTIVE_CLASSES, REVIEW_MARK_CLASSES } from '../markdown-prose';

export interface HighlightSegment {
	text: string;
	/** The annotation this segment is highlighted for; undefined = plain text. */
	reviewId?: string;
}

/**
 * Split `stream[from, to)` around the claimed ranges it intersects. A range
 * spanning the slice boundary yields a segment in each slice it covers, both
 * carrying the same review id - the same behaviour the markdown surface has
 * for a quote spanning several text nodes.
 */
export function segmentsForSlice(
	stream: string,
	from: number,
	to: number,
	claimed: MatchRange[],
): HighlightSegment[] {
	const segments: HighlightSegment[] = [];
	let cursor = from;
	for (const range of claimed) {
		const start = Math.max(range.start, from);
		const end = Math.min(range.end, to);
		if (end <= start) continue;
		if (start > cursor) segments.push({ text: stream.slice(cursor, start) });
		segments.push({ text: stream.slice(start, end), reviewId: range.id });
		cursor = end;
	}
	if (cursor < to) segments.push({ text: stream.slice(cursor, to) });
	return segments;
}

interface ReviewTextSegmentsProps {
	segments: HighlightSegment[];
	activeId: string | null;
	onHighlightClick: (id: string) => void;
}

/**
 * Render pre-sliced segments, highlighted ones wrapped in the same clickable
 * `mark[data-review-id]` the markdown surface produces. Emits nothing but the
 * segment text, so the container's DOM text stream stays byte-identical to the
 * string the segments were sliced from - which is what lets a selection made
 * here resolve back to a `{ quote, occurrence }` anchor.
 */
export function ReviewTextSegments({
	segments,
	activeId,
	onHighlightClick,
}: ReviewTextSegmentsProps) {
	return (
		<>
			{segments.map((seg, i) =>
				seg.reviewId ? (
					// biome-ignore lint/a11y/useSemanticElements: a <button> cannot wrap arbitrary inline pre text; the mark carries role/tabIndex/keydown instead (same pattern as markdown-prose)
					<mark
						// biome-ignore lint/suspicious/noArrayIndexKey: segments are a pure slicing of the stream — stable for a given (stream, annotations)
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
		</>
	);
}
