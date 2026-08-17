import { useMemo } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useSignedUrlText } from '../hooks/use-signed-url-text';
import { AssetIcon } from './asset-icon';

// Thumbnails only ever show the top slice, so parse just the head of the file —
// this bounds react-markdown's work for a large (or mislabeled) text asset.
const THUMBNAIL_SOURCE_LIMIT = 8000;

// The card media is a <button>; keep the preview inert and free of interactive
// descendants — drop links to plain text and never load (external) images.
const THUMBNAIL_COMPONENTS: Components = {
	a: ({ children }) => <span>{children}</span>,
	img: ({ alt }) => <span>{alt ?? ''}</span>,
};

/**
 * Rendered-markdown preview for an asset card's media area: fetches the asset's
 * text from its signed URL and renders the first bit of it as a tiny,
 * non-interactive prose block scaled to look like a mini document. Falls back to
 * the file glyph while the fetch is in flight or if it fails (or the file is
 * empty), so the card never shows a blank box.
 */
export function MarkdownThumbnail({ url, contentType }: { url: string; contentType: string }) {
	const { text } = useSignedUrlText(url);
	const snippet = useMemo(() => text?.slice(0, THUMBNAIL_SOURCE_LIMIT) ?? '', [text]);
	if (!text?.trim()) return <AssetIcon contentType={contentType} />;
	return (
		<div
			data-testid="asset-markdown-thumbnail"
			aria-hidden
			className="pointer-events-none h-full w-full overflow-hidden [mask-image:linear-gradient(to_bottom,black_65%,transparent)]"
		>
			{/* prose-sm rendered at ~60% via transform - proportional headings and
			    spacing read as a real document; w-[166%] refills the width post-scale. */}
			<div className="w-[166%] origin-top-left scale-[0.6] px-3 py-2 prose prose-sm max-w-none [&_*]:text-text-1!">
				<Markdown remarkPlugins={[remarkGfm]} components={THUMBNAIL_COMPONENTS}>
					{snippet}
				</Markdown>
			</div>
		</div>
	);
}
