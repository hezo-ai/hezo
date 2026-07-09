interface InlineCodeNode {
	type: 'inlineCode';
	value: string;
}

interface ParentNode {
	type: string;
	children?: MdNode[];
	value?: string;
}

type MdNode = ParentNode | InlineCodeNode;

/**
 * Strip the redundant backtick delimiters an author left *inside* an inline-code
 * span. LLM-authored markdown routinely double-wraps a token — writing
 * `` `x` `` — which the GFM parser turns into a single `inlineCode` node whose
 * *value* is the literal string "`x`" (the outer `` `` `` are the real
 * delimiters; the inner backticks become part of the content). The renderer then
 * paints a code chip that still shows those inner backticks, so the reader sees
 * an ugly double-backticked token where a clean `x` chip was meant.
 *
 * Only a whole-span wrapper is unwrapped, and only while the interior carries no
 * backtick of its own — so a span that deliberately shows a backtick (`` `a`b` ``)
 * is left untouched. A single already-clean span (`x`) has no interior backticks
 * and is a no-op.
 */
export function unwrapRedundantBackticks(value: string): string {
	let v = value;
	while (v.length >= 2 && v.startsWith('`') && v.endsWith('`')) {
		const inner = v.slice(1, -1).trim();
		if (inner.length === 0 || inner.includes('`')) break;
		v = inner;
	}
	return v;
}

function walk(node: ParentNode) {
	const children = node.children;
	if (!children) return;
	for (const child of children) {
		if (child.type === 'inlineCode' && typeof (child as InlineCodeNode).value === 'string') {
			(child as InlineCodeNode).value = unwrapRedundantBackticks((child as InlineCodeNode).value);
			continue;
		}
		if ((child as ParentNode).children) walk(child as ParentNode);
	}
}

/**
 * Remark plugin that normalizes every inline-code span via
 * {@link unwrapRedundantBackticks}. Fenced code blocks are a different mdast node
 * (`code`, not `inlineCode`) and are never visited, so genuine multi-line code
 * samples keep their backticks. Runs before the mention/comment-ref plugins so
 * their inline-code linkifiers (chat doc/asset links, comment public_ids) see the
 * unwrapped value.
 */
export function remarkNormalizeInlineCode() {
	return (tree: ParentNode) => {
		walk(tree);
	};
}
