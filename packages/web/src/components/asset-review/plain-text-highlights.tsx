import { useMemo } from 'react';
import { findLinkRanges } from '../../lib/autolink';
import { claimQuoteRanges, type ReviewAnnotation } from '../../lib/rehype-review-highlights';
import { ReviewTextSegments, segmentsForSlice } from './review-text-segments';

interface PlainTextWithHighlightsProps {
	content: string;
	annotations: ReviewAnnotation[];
	activeId: string | null;
	onHighlightClick: (id: string) => void;
}

/**
 * A plain-text asset body with review highlights: the string renders inside a
 * `<pre>`, quote anchors wrapped in clickable marks and URLs in anchors. The
 * pre's DOM text stream is byte-identical to the source string, so
 * `computeSelectionAnchor` resolves selections against it exactly as it does
 * for rendered markdown.
 */
export function PlainTextWithHighlights({
	content,
	annotations,
	activeId,
	onHighlightClick,
}: PlainTextWithHighlightsProps) {
	const links = useMemo(() => findLinkRanges(content), [content]);
	const segments = useMemo(
		() =>
			segmentsForSlice(content, 0, content.length, claimQuoteRanges(content, annotations), links),
		[content, annotations, links],
	);
	return (
		<pre
			data-testid="asset-plain-text"
			className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-text-1"
		>
			<ReviewTextSegments
				segments={segments}
				activeId={activeId}
				onHighlightClick={onHighlightClick}
			/>
		</pre>
	);
}
