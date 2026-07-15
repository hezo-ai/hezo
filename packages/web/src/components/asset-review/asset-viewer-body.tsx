import { isTextReviewableAssetMime, type ProjectAsset } from '@hezo/shared';
import { ExternalLink } from 'lucide-react';
import { AssetIcon, formatBytes } from '../asset-icon';
import { type AssetReviewControls, ReviewableAssetText } from './reviewable-asset-text';

interface AssetViewerBodyProps {
	/** Route-param project slug. */
	projectId: string;
	asset: ProjectAsset;
	/** Archived assets render read-only. */
	readOnly: boolean;
	review: AssetReviewControls;
}

/**
 * The viewer's left pane, dispatched by content type: text assets (markdown,
 * plain text) get the full review surface; images/SVG render scaled via
 * `<img>` (safe — image-loaded SVG can't script); HTML renders in the same
 * sandboxed frame the serve-side CSP pins to an opaque origin; everything else
 * gets a metadata card. Non-text types take whole-asset comments from the
 * review panel — region (rect) anchoring is future work (.dev/architecture.md).
 */
export function AssetViewerBody({ projectId, asset, readOnly, review }: AssetViewerBodyProps) {
	if (isTextReviewableAssetMime(asset.content_type)) {
		return (
			<ReviewableAssetText
				projectId={projectId}
				asset={asset}
				readOnly={readOnly}
				review={review}
			/>
		);
	}
	if (asset.content_type.startsWith('image/')) {
		return (
			<img
				src={asset.url}
				alt={asset.original_filename}
				data-testid="asset-viewer-image"
				className="h-auto max-w-full rounded-md border border-border bg-surface-3"
			/>
		);
	}
	if (asset.content_type === 'text/html') {
		return (
			// Interactive on purpose — the serve-side CSP (`sandbox allow-scripts …`)
			// pins the page to an opaque origin; the attribute mirrors it for
			// defense in depth (keep the two token lists in lockstep — see
			// ASSET_SANDBOX_CSP). `allow-downloads` lets an in-page button save a
			// file; it grants no same-origin access. Height is viewport-bound; the
			// page scrolls inside.
			<iframe
				src={asset.url}
				title={asset.original_filename}
				sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
				data-testid="asset-viewer-html"
				className="h-[75vh] w-full rounded-md border border-border bg-surface"
			/>
		);
	}
	return (
		<div
			className="flex flex-col items-center gap-3 rounded-md border border-border bg-surface-2 px-6 py-10"
			data-testid="asset-viewer-metadata"
		>
			<AssetIcon contentType={asset.content_type} className="h-12 w-12 text-text-3" />
			<div className="text-center">
				<div className="break-all text-sm font-medium text-text-1">{asset.original_filename}</div>
				<div className="mt-1 text-[12px] text-text-3">
					{asset.content_type} · {formatBytes(asset.byte_size)}
				</div>
			</div>
			<a
				href={asset.url}
				target="_blank"
				rel="noopener noreferrer"
				className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-accent-soft-fg hover:underline"
			>
				<ExternalLink className="h-3.5 w-3.5" />
				Open raw file
			</a>
		</div>
	);
}
