/**
 * DOM-side anchor computation for document review comments: turn a text
 * selection (or a hovered block) inside the rendered prose container into the
 * `{ quote, occurrence }` anchor that `rehype-review-highlights` resolves.
 *
 * The text stream walked here — every text node under the container in
 * document order — is the DOM mirror of the hast text stream the rehype
 * plugin walks, so an anchor computed on one side resolves on the other.
 */

export interface ReviewAnchor {
	quote: string;
	occurrence: number;
}

interface DomTextStream {
	nodes: Text[];
	/** Global offset of each node's first character. */
	starts: number[];
	stream: string;
}

export function collectDomText(container: HTMLElement): DomTextStream {
	const nodes: Text[] = [];
	const starts: number[] = [];
	let stream = '';
	const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		nodes.push(node as Text);
		starts.push(stream.length);
		stream += (node as Text).data;
	}
	return { nodes, starts, stream };
}

/** How many times `quote` occurs in `stream` strictly before `globalStart`. */
function countOccurrencesBefore(stream: string, quote: string, globalStart: number): number {
	let count = 0;
	let idx = stream.indexOf(quote);
	while (idx !== -1 && idx < globalStart) {
		count++;
		idx = stream.indexOf(quote, idx + 1);
	}
	return count;
}

/**
 * Resolve a Range boundary to a global offset in the container's text stream.
 * Text-node boundaries (the overwhelmingly common case for mouse/touch
 * selections) resolve exactly; element boundaries (triple-click in some
 * browsers) resolve to the first text position at/after the boundary.
 */
function resolveBoundary(text: DomTextStream, node: Node, offset: number): number | null {
	if (node.nodeType === Node.TEXT_NODE) {
		const i = text.nodes.indexOf(node as Text);
		if (i === -1) return null;
		return text.starts[i] + Math.min(offset, text.nodes[i].data.length);
	}
	if (node.nodeType !== Node.ELEMENT_NODE) return null;
	const el = node as Element;
	// Boundary sits before el.childNodes[offset]: the first collected text node
	// at/after that point in document order marks the position.
	const anchor = el.childNodes[offset] ?? null;
	for (let i = 0; i < text.nodes.length; i++) {
		const candidate = text.nodes[i];
		if (anchor) {
			const rel = anchor.compareDocumentPosition(candidate);
			if (
				anchor === candidate ||
				rel & Node.DOCUMENT_POSITION_CONTAINED_BY ||
				rel & Node.DOCUMENT_POSITION_FOLLOWING
			) {
				return text.starts[i];
			}
		} else {
			// Boundary at the end of el: first text node after el entirely.
			const rel = el.compareDocumentPosition(candidate);
			if (rel & Node.DOCUMENT_POSITION_FOLLOWING && !(rel & Node.DOCUMENT_POSITION_CONTAINED_BY)) {
				return text.starts[i];
			}
		}
	}
	return text.stream.length;
}

/**
 * Anchor for the current selection range. Returns null when the selection is
 * collapsed, falls outside the container, or covers no text.
 */
export function computeSelectionAnchor(container: HTMLElement, range: Range): ReviewAnchor | null {
	if (range.collapsed) return null;
	if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) {
		return null;
	}
	const text = collectDomText(container);
	const start = resolveBoundary(text, range.startContainer, range.startOffset);
	const end = resolveBoundary(text, range.endContainer, range.endOffset);
	if (start === null || end === null || end <= start) return null;
	const quote = text.stream.slice(start, end);
	if (quote.trim() === '') return null;
	return { quote, occurrence: countOccurrencesBefore(text.stream, quote, start) };
}

/**
 * Anchor for a whole block element (the hover-a-line affordance): the quote is
 * the block's full text. Returns null for empty blocks.
 */
export function computeBlockAnchor(
	container: HTMLElement,
	block: HTMLElement,
): ReviewAnchor | null {
	if (!container.contains(block)) return null;
	const text = collectDomText(container);
	const blockText = collectDomText(block);
	if (blockText.stream.trim() === '' || blockText.nodes.length === 0) return null;
	const first = blockText.nodes[0];
	const i = text.nodes.indexOf(first);
	if (i === -1) return null;
	const start = text.starts[i];
	return {
		quote: blockText.stream,
		occurrence: countOccurrencesBefore(text.stream, blockText.stream, start),
	};
}
