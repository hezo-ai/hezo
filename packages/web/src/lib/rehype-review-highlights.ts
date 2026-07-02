/**
 * Rehype plugin that wraps review-comment quotes in `<mark data-review-id>`
 * elements over the rendered document.
 *
 * Anchoring model: a review comment stores the exact `quote` text plus which
 * `occurrence` of that text (0-based) it targets, measured over the document's
 * rendered text stream — the concatenation of every hast text node in document
 * order. That stream is identical to the DOM text-node stream the selection
 * capture walks (react-markdown renders hast text nodes 1:1, including the
 * newline separators between blocks), so anchors computed from a DOM selection
 * resolve here without any offset bookkeeping. Comments are wiped server-side
 * whenever the document content changes, so an anchor can only fail to match
 * across rare hast/DOM divergences (e.g. a quote spanning a mention rewritten
 * by remark-mentions) — an unmatched quote simply renders no highlight.
 *
 * There is no `rehype-raw` in this app: these element nodes are injected into
 * the tree directly, never parsed from HTML strings, so no raw-HTML surface is
 * opened.
 */

export interface ReviewAnnotation {
	id: string;
	quote: string;
	occurrence: number;
}

interface HastText {
	type: 'text';
	value: string;
}

interface HastParent {
	type: string;
	tagName?: string;
	children?: HastChild[];
}

type HastChild = (HastText | HastParent) & { properties?: Record<string, unknown> };

interface TextRef {
	parent: HastParent;
	node: HastText;
	/** Global offset of this node's first character in the text stream. */
	start: number;
}

interface MatchRange {
	id: string;
	start: number;
	end: number;
}

function isText(node: HastChild): node is HastText & HastChild {
	return node.type === 'text' && typeof (node as HastText).value === 'string';
}

function collectTextRefs(parent: HastParent, refs: TextRef[], offset: { value: number }): void {
	if (!parent.children) return;
	for (const child of parent.children) {
		if (isText(child)) {
			refs.push({ parent, node: child, start: offset.value });
			offset.value += child.value.length;
			continue;
		}
		collectTextRefs(child as HastParent, refs, offset);
	}
}

/** Global [start, end) of the nth occurrence of `quote` in `stream`, or null. */
export function findQuoteRange(
	stream: string,
	quote: string,
	occurrence: number,
): { start: number; end: number } | null {
	if (!quote) return null;
	let idx = -1;
	let from = 0;
	for (let i = 0; i <= occurrence; i++) {
		idx = stream.indexOf(quote, from);
		if (idx === -1) return null;
		from = idx + 1;
	}
	return { start: idx, end: idx + quote.length };
}

/**
 * Wrap every annotation's quote in `<mark data-review-id>` elements, splitting
 * text nodes at match boundaries (a quote spanning several text nodes yields
 * several marks sharing the id). Overlapping matches: earlier annotations win,
 * later ones are skipped (the creation UI already prevents overlaps). Returns
 * the ids that matched. Exported for direct unit tests; the plugin below is
 * the react-markdown entry point.
 */
export function applyReviewHighlights(
	tree: HastParent,
	annotations: ReviewAnnotation[],
): Set<string> {
	const refs: TextRef[] = [];
	collectTextRefs(tree, refs, { value: 0 });
	const stream = refs.map((r) => r.node.value).join('');

	const claimed: MatchRange[] = [];
	for (const ann of annotations) {
		const range = findQuoteRange(stream, ann.quote, ann.occurrence);
		if (!range) continue;
		if (claimed.some((c) => range.start < c.end && c.start < range.end)) continue;
		claimed.push({ id: ann.id, ...range });
	}
	if (claimed.length === 0) return new Set();
	claimed.sort((a, b) => a.start - b.start);

	// Group refs per parent and splice replacements from the last child first,
	// so earlier refs' child indices stay valid while we mutate.
	const byParent = new Map<HastParent, TextRef[]>();
	for (const ref of refs) {
		const group = byParent.get(ref.parent);
		if (group) group.push(ref);
		else byParent.set(ref.parent, [ref]);
	}

	for (const [parent, group] of byParent) {
		for (let i = group.length - 1; i >= 0; i--) {
			const ref = group[i];
			const replacements = splitTextRef(ref, claimed);
			if (!replacements) continue;
			const children = parent.children as HastChild[];
			const index = children.indexOf(ref.node as HastChild);
			if (index === -1) continue;
			children.splice(index, 1, ...replacements);
		}
	}

	return new Set(claimed.map((c) => c.id));
}

/** Split one text node around the match ranges it intersects; null = untouched. */
function splitTextRef(ref: TextRef, ranges: MatchRange[]): HastChild[] | null {
	const nodeStart = ref.start;
	const nodeEnd = ref.start + ref.node.value.length;
	const hits = ranges.filter((r) => r.start < nodeEnd && nodeStart < r.end);
	if (hits.length === 0) return null;

	const out: HastChild[] = [];
	let pos = nodeStart;
	for (const hit of hits) {
		const from = Math.max(hit.start, nodeStart);
		const to = Math.min(hit.end, nodeEnd);
		if (from > pos) {
			out.push({ type: 'text', value: ref.node.value.slice(pos - nodeStart, from - nodeStart) });
		}
		out.push({
			type: 'element',
			tagName: 'mark',
			properties: { dataReviewId: hit.id },
			children: [{ type: 'text', value: ref.node.value.slice(from - nodeStart, to - nodeStart) }],
		} as HastChild);
		pos = to;
	}
	if (pos < nodeEnd) {
		out.push({ type: 'text', value: ref.node.value.slice(pos - nodeStart) });
	}
	return out;
}

/** react-markdown rehype plugin entry point. */
export function rehypeReviewHighlights(options: { annotations: ReviewAnnotation[] }) {
	return (tree: HastParent) => {
		if (options.annotations.length === 0) return;
		applyReviewHighlights(tree, options.annotations);
	};
}
