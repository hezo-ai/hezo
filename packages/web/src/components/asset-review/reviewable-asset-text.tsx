import { isMarkdownAssetMime, type ProjectAsset } from '@hezo/shared';
import { Loader2 } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import type { AssetReviewComment } from '../../hooks/use-asset-review';
import { useSignedUrlText } from '../../hooks/use-signed-url-text';
import { CSV_PREVIEW_ROW_LIMIT, isCsvAssetPath, parseCsvPreview } from '../../lib/csv';
import type { ReviewAnchor } from '../../lib/doc-review-selection';
import type { ReviewAnnotation } from '../../lib/rehype-review-highlights';
import { ReviewSurface } from '../document-review/review-surface';
import { MarkdownProse } from '../markdown-prose';
import { Button } from '../ui/button';
import { CsvTable } from './csv-table';
import { PlainTextWithHighlights } from './plain-text-highlights';

type ViewMode = 'preview' | 'source';

const TAB_BASE = 'px-2.5 py-1 rounded';
const TAB_ACTIVE = 'bg-surface text-text-1 shadow-sm';
const TAB_INACTIVE = 'text-text-2 hover:text-text-1';

const NO_ROWS: string[][] = [];
const NO_ANNOTATIONS: ReviewAnnotation[] = [];

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
 * A text asset (markdown, CSV or plain text) in the viewer's left pane, wrapped
 * in the shared `ReviewSurface` so selections and line hovers comment exactly as
 * they do on project docs.
 *
 * Types with a richer reading than their raw bytes - markdown as prose, a CSV
 * as a table - render that as the Preview tab and keep the raw file behind
 * Source. Anchors are computed over the Preview stream, so the Source tab
 * renders without review affordances.
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

	// A `.csv` is stored as text/plain, so the table reading is chosen by
	// filename. One that parses to a single column (or none) gains nothing from
	// a table and stays plain text.
	const csv = useMemo(
		() => (isCsvAssetPath(asset.original_filename) && text !== null ? parseCsvPreview(text) : null),
		[asset.original_filename, text],
	);
	const table = csv && csv.rows.length > 0 && csv.rows[0].length > 1 ? csv : null;

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

	const rows = table?.rows ?? NO_ROWS;
	const renderTable = useCallback(
		(
			annotations: ReviewAnnotation[],
			onHighlightClick: (id: string) => void,
			active: string | null,
		) => (
			<CsvTable
				rows={rows}
				annotations={annotations}
				activeId={active}
				onHighlightClick={onHighlightClick}
			/>
		),
		[rows],
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

	const renderPreview = isMarkdown ? renderMarkdown : table ? renderTable : renderPlainText;
	const surface = readOnly ? (
		renderPreview(NO_ANNOTATIONS, () => {}, null)
	) : (
		<ReviewSurface
			comments={review.comments}
			saving={review.saving}
			activeId={review.activeId}
			onActiveIdChange={review.onActiveIdChange}
			onCreate={review.onCreate}
			onUpdate={review.onUpdate}
			onDelete={review.onDelete}
			renderContent={renderPreview}
		/>
	);

	// A file whose raw bytes already are the readable form needs no tabs.
	if (!isMarkdown && !table) return surface;
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
				<>
					{surface}
					{/* Kept outside the review surface: text rendered inside it joins the
					    stream anchors are measured over. */}
					{table?.truncated && (
						<p className="mt-2 text-[12px] text-text-3" data-testid="asset-csv-truncated">
							Showing the first {CSV_PREVIEW_ROW_LIMIT} rows. Open Source or download the file for
							the rest.
						</p>
					)}
				</>
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
