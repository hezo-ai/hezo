import { isMarkdownAssetMime, type ProjectAsset } from '@hezo/shared';
import { Loader2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import type { AssetReviewComment } from '../../hooks/use-asset-review';
import { useSignedUrlText } from '../../hooks/use-signed-url-text';
import type { ReviewAnchor } from '../../lib/doc-review-selection';
import type { ReviewAnnotation } from '../../lib/rehype-review-highlights';
import { ReviewSurface } from '../document-review/review-surface';
import { MarkdownProse } from '../markdown-prose';
import { Button } from '../ui/button';
import { PlainTextWithHighlights } from './plain-text-highlights';

type ViewMode = 'preview' | 'source';

const TAB_BASE = 'px-2.5 py-1 rounded';
const TAB_ACTIVE = 'bg-surface text-text-1 shadow-sm';
const TAB_INACTIVE = 'text-text-2 hover:text-text-1';

export interface AssetReviewControls {
	comments: AssetReviewComment[] | undefined;
	saving: boolean;
	activeId: string | null;
	onActiveIdChange: (id: string | null) => void;
	onCreate: (anchor: ReviewAnchor, text: string) => Promise<void>;
	onUpdate: (commentId: string, text: string) => void;
	onDelete: (commentId: string) => void;
}

interface ReviewableAssetTextProps {
	/** Route-param project slug (mention resolution + query keys). */
	projectId: string;
	asset: ProjectAsset;
	/** Archived assets render read-only: no selection pill, no editor. */
	readOnly: boolean;
	review: AssetReviewControls;
}

/**
 * A text asset (markdown or plain text) in the viewer's left pane, wrapped in
 * the shared `ReviewSurface` so selections and line hovers comment exactly as
 * they do on project docs. Markdown keeps the Preview / Source tabs the old
 * asset dialog had; anchors are computed over the Preview stream, so the
 * Source tab renders without review affordances.
 */
export function ReviewableAssetText({
	projectId,
	asset,
	readOnly,
	review,
}: ReviewableAssetTextProps) {
	const isMarkdown = isMarkdownAssetMime(asset.content_type);
	const [mode, setMode] = useState<ViewMode>('preview');
	const { text, error, reload } = useSignedUrlText(asset.url);

	const renderMarkdown = useCallback(
		(
			annotations: ReviewAnnotation[],
			onHighlightClick: (id: string) => void,
			active: string | null,
		) => (
			<MarkdownProse
				projectId={projectId}
				testId="asset-viewer-rendered"
				reviewAnnotations={annotations}
				onReviewHighlightClick={onHighlightClick}
				activeReviewId={active}
			>
				{text ?? ''}
			</MarkdownProse>
		),
		[projectId, text],
	);

	const renderPlainText = useCallback(
		(
			annotations: ReviewAnnotation[],
			onHighlightClick: (id: string) => void,
			active: string | null,
		) => (
			<PlainTextWithHighlights
				content={text ?? ''}
				annotations={annotations}
				activeId={active}
				onHighlightClick={onHighlightClick}
			/>
		),
		[text],
	);

	if (error) {
		return (
			<div
				className="flex items-center gap-3 text-[13px] text-danger"
				data-testid="asset-viewer-error"
			>
				<span>{error}</span>
				<Button size="sm" variant="secondary" onClick={reload}>
					Reload
				</Button>
			</div>
		);
	}
	if (text === null) {
		return (
			<div className="flex items-center gap-2 text-[13px] text-text-2">
				<Loader2 className="h-3.5 w-3.5 animate-spin" />
				Loading…
			</div>
		);
	}

	const surface = readOnly ? (
		isMarkdown ? (
			<MarkdownProse projectId={projectId} testId="asset-viewer-rendered">
				{text}
			</MarkdownProse>
		) : (
			<PlainTextWithHighlights
				content={text}
				annotations={[]}
				activeId={null}
				onHighlightClick={() => {}}
			/>
		)
	) : (
		<ReviewSurface
			comments={review.comments}
			saving={review.saving}
			activeId={review.activeId}
			onActiveIdChange={review.onActiveIdChange}
			onCreate={review.onCreate}
			onUpdate={review.onUpdate}
			onDelete={review.onDelete}
			renderContent={isMarkdown ? renderMarkdown : renderPlainText}
		/>
	);

	if (!isMarkdown) return surface;
	return (
		<div>
			<div
				role="tablist"
				aria-label="Asset view mode"
				className="mb-3 inline-flex rounded-md border border-border-subtle bg-surface-2 p-0.5 text-xs"
			>
				<button
					type="button"
					role="tab"
					aria-selected={mode === 'preview'}
					onClick={() => setMode('preview')}
					className={`${TAB_BASE} ${mode === 'preview' ? TAB_ACTIVE : TAB_INACTIVE}`}
					data-testid="asset-viewer-preview-tab"
				>
					Preview
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={mode === 'source'}
					onClick={() => setMode('source')}
					className={`${TAB_BASE} ${mode === 'source' ? TAB_ACTIVE : TAB_INACTIVE}`}
					data-testid="asset-viewer-source-tab"
				>
					Source
				</button>
			</div>
			{mode === 'preview' ? (
				surface
			) : (
				<pre
					className="whitespace-pre-wrap break-words font-mono text-[12px] text-text-1"
					data-testid="asset-viewer-source"
				>
					{text}
				</pre>
			)}
		</div>
	);
}
