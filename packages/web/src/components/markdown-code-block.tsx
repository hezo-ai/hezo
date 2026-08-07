import { Check, Copy } from 'lucide-react';
import type { ComponentProps } from 'react';
import { useCopyFeedback } from '../hooks/use-copy-feedback';
import { useI18n } from '../lib/i18n';

/**
 * Minimal shape of the hast nodes react-markdown hands a component override.
 * Declared locally rather than imported from `hast` - the same idiom
 * `lib/rehype-review-highlights.ts` uses, so this module takes no dependency on
 * a type package that only arrives transitively through react-markdown.
 */
interface HastNodeLike {
	type?: string;
	value?: unknown;
	children?: unknown;
}

/**
 * The raw source of a fenced code block, read off its hast node.
 *
 * Reading hast rather than the rendered React children is what makes this
 * exact: `rehype-review-highlights` splits the code's single text node into
 * several, interleaved with `<mark>` elements, whenever a review comment's quote
 * lands inside the fence - so the original string is only recoverable by walking
 * the tree. `mdast-util-to-hast` appends one trailing newline when it builds the
 * `<pre><code>` pair (a rendering artifact, not the author's code), so drop
 * exactly one.
 */
export function codeBlockText(node: unknown): string {
	const text = collectText(node);
	return text.endsWith('\n') ? text.slice(0, -1) : text;
}

function collectText(node: unknown): string {
	if (!node || typeof node !== 'object') return '';
	const n = node as HastNodeLike;
	if (n.type === 'text') return typeof n.value === 'string' ? n.value : '';
	if (!Array.isArray(n.children)) return '';
	let out = '';
	for (const child of n.children) out += collectText(child);
	return out;
}

/**
 * A rendered markdown code block with a copy button overlaid on its bottom-right
 * corner. Registered as MarkdownProse's `pre` override; inline `<code>` never
 * reaches it (mdast only emits `<pre>` for fenced and indented blocks).
 *
 * Three pieces of this are load-bearing and invisible:
 *
 * 1. The button cannot live inside the `<pre>`. `.prose pre` is `overflow-x:
 *    auto`, so an absolutely positioned child would be positioned against the
 *    scroll container and slide out of view horizontally with the code. Hence
 *    the wrapper.
 *
 * 2. The wrapper is deliberately bare - no padding, no border, no `overflow`,
 *    no `flow-root`. `position: relative` does not establish a block formatting
 *    context, so the pre's typography margins collapse *through* the wrapper and
 *    the wrapper's border box ends up identical to the pre's. That is what puts
 *    `bottom-2 right-2` inside the code block instead of out in the margin gap,
 *    and what keeps the block's spacing identical to the unwrapped version.
 *    Adding any of those properties silently drops the button below the block.
 *
 * 3. Wrapping costs the two typography resets: `.prose > :first-child` /
 *    `:last-child` now land on the wrapper, whose own margin is already 0, and a
 *    collapse takes the max - so the pre's margin would survive at the very top
 *    or bottom of a prose block. The two arbitrary variants below re-apply the
 *    resets to the pre itself.
 *
 * The button must also stay icon-only. `lib/doc-review-selection.ts` walks every
 * text node under the prose container and that stream has to stay identical to
 * the hast stream `rehype-review-highlights` anchors against; an SVG contributes
 * no text nodes, but a visible label would, and would break review anchoring on
 * every document and text-asset surface.
 */
export function MarkdownCodeBlock({
	node,
	children,
	...preProps
}: ComponentProps<'pre'> & { node?: unknown }) {
	const { t } = useI18n();
	const { copied, copy } = useCopyFeedback();

	const handleCopy = async () => {
		await copy(codeBlockText(node));
	};

	return (
		<div
			data-testid="markdown-code-block"
			className="relative group/code-block [&:first-child_pre]:mt-0 [&:last-child_pre]:mb-0"
		>
			{/* `preProps` forwards whatever react-markdown put on the element (a
			    className a rehype plugin added, for instance) so wrapping stays
			    lossless; `node` is react-markdown's own extra prop and must not
			    reach the DOM. */}
			<pre {...preProps}>{children}</pre>
			{/* Keyed on hover *capability*, not screen size (the same idiom as the chat
			    message copy button): pointer devices reveal it on hover so it never
			    sits over the code, touch devices keep it visible so it stays
			    reachable. `pointer-events-none` while hidden matters here in a way it
			    doesn't for the chat button - an opacity-0 overlay still hit-tests and
			    would block text selection in the block's corner. */}
			<button
				type="button"
				onClick={handleCopy}
				aria-label={copied ? t('common.copied') : t('common.copy')}
				data-testid="code-block-copy"
				className="absolute bottom-2 right-2 z-10 flex h-6 w-6 items-center justify-center rounded-md border border-border bg-surface-3 text-text-3 shadow-xs transition-opacity hover:bg-surface-2 hover:text-text-1 focus-visible:opacity-100 group-hover/code-block:pointer-events-auto group-hover/code-block:opacity-100 [@media(hover:hover)]:pointer-events-none [@media(hover:hover)]:opacity-0"
			>
				{copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
			</button>
		</div>
	);
}
