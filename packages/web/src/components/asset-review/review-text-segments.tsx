import { Fragment } from 'react';
import type { LinkRange } from '../../lib/autolink';
import type { MatchRange } from '../../lib/rehype-review-highlights';
import { REVIEW_MARK_ACTIVE_CLASSES, REVIEW_MARK_CLASSES } from '../markdown-prose';

export interface HighlightSegment {
	text: string;
	/** The annotation this segment is highlighted for; undefined = plain text. */
	reviewId?: string;
	/** The link this segment falls inside; undefined = not part of one. */
	href?: string;
}

const NO_LINKS: LinkRange[] = [];

// The markdown surface's link colour, so a URL reads the same whichever pane it
// is in. Wrapping is left to the container (`break-words` on the cell and the
// plain-text `pre`), which already breaks an over-long URL.
const LINK_CLASSES = 'text-info-soft-fg underline underline-offset-2 hover:opacity-80';

/**
 * Split `stream[from, to)` around the claimed review ranges and link ranges it
 * intersects. A range spanning the slice boundary yields a segment in each
 * slice it covers, both carrying the same id/href - the same behaviour the
 * markdown surface has for a quote spanning several text nodes.
 *
 * Both range lists must be sorted by `start` and internally non-overlapping;
 * `claimQuoteRanges` and `findLinkRanges` each guarantee that. The two lists
 * may overlap each other, in which case a segment carries both.
 */
export function segmentsForSlice(
	stream: string,
	from: number,
	to: number,
	claimed: MatchRange[],
	links: LinkRange[] = NO_LINKS,
): HighlightSegment[] {
	const cuts = new Set<number>();
	for (const range of claimed) {
		if (range.start > from && range.start < to) cuts.add(range.start);
		if (range.end > from && range.end < to) cuts.add(range.end);
	}
	for (const range of links) {
		if (range.start > from && range.start < to) cuts.add(range.start);
		if (range.end > from && range.end < to) cuts.add(range.end);
	}
	const points = [from, ...Array.from(cuts).sort((a, b) => a - b), to];

	const segments: HighlightSegment[] = [];
	// Both lists are sorted, and the cut points ascend, so one cursor each walks
	// them in step with the segments rather than rescanning per segment.
	let ci = 0;
	let li = 0;
	for (let i = 0; i + 1 < points.length; i++) {
		const start = points[i];
		const end = points[i + 1];
		if (end <= start) continue;
		while (ci < claimed.length && claimed[ci].end <= start) ci++;
		while (li < links.length && links[li].end <= start) li++;
		const review = ci < claimed.length && claimed[ci].start <= start ? claimed[ci] : undefined;
		const link = li < links.length && links[li].start <= start ? links[li] : undefined;
		segments.push({ text: stream.slice(start, end), reviewId: review?.id, href: link?.href });
	}
	return segments;
}

interface ReviewTextSegmentsProps {
	segments: HighlightSegment[];
	activeId: string | null;
	onHighlightClick: (id: string) => void;
}

/**
 * Render pre-sliced segments: highlighted ones wrapped in the same clickable
 * `mark[data-review-id]` the markdown surface produces, linked ones in an
 * anchor. Both wrappers emit nothing but the segment text, so the container's
 * DOM text stream stays byte-identical to the string the segments were sliced
 * from - which is what lets a selection made here resolve back to a
 * `{ quote, occurrence }` anchor.
 */
export function ReviewTextSegments({
	segments,
	activeId,
	onHighlightClick,
}: ReviewTextSegmentsProps) {
	return (
		<>
			{segments.map((seg, i) => {
				// A linked segment renders as an anchor, a highlighted one as the same
				// clickable mark the markdown surface produces, and one that is both
				// nests the anchor inside the mark. Plain text stays a bare string so
				// the common case adds no element at all.
				const link = seg.href ? (
					<a
						href={seg.href}
						target="_blank"
						rel="noopener noreferrer"
						className={LINK_CLASSES}
						data-testid="autolink"
						// A click on a link inside a highlight follows the link and does
						// nothing else; the highlight stays clickable across the rest of
						// its quote, and its comment is listed in the review panel too.
						onClick={(e) => e.stopPropagation()}
					>
						{seg.text}
					</a>
				) : null;
				if (!seg.reviewId) {
					// biome-ignore lint/suspicious/noArrayIndexKey: segments are a pure slicing of the stream — stable for a given (stream, annotations, links)
					return link ? <Fragment key={i}>{link}</Fragment> : seg.text;
				}
				const reviewId = seg.reviewId;
				return (
					// biome-ignore lint/a11y/useSemanticElements: a <button> cannot wrap arbitrary inline pre text; the mark carries role/tabIndex/keydown instead (same pattern as markdown-prose)
					<mark
						// biome-ignore lint/suspicious/noArrayIndexKey: segments are a pure slicing of the stream — stable for a given (stream, annotations, links)
						key={i}
						data-review-id={reviewId}
						data-testid="review-highlight"
						className={reviewId === activeId ? REVIEW_MARK_ACTIVE_CLASSES : REVIEW_MARK_CLASSES}
						onClick={() => onHighlightClick(reviewId)}
						onKeyDown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								onHighlightClick(reviewId);
							}
						}}
						// biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: the highlight is genuinely interactive (opens its comment editor); full keyboard support is provided
						role="button"
						tabIndex={0}
					>
						{link ?? seg.text}
					</mark>
				);
			})}
		</>
	);
}
