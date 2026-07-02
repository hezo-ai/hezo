import { ExternalLink, X } from 'lucide-react';
import { useProjectDoc } from '../../hooks/use-project-docs';
import { docPreviewPath } from '../../lib/doc-preview';
import { ReviewHelp } from '../document-review/review-help';
import { ReviewToolbarActions } from '../document-review/review-toolbar-actions';
import { ReviewableDocument } from '../document-review/reviewable-document';
import type { PreviewItem } from './preview-context';

function formatBytes(bytes?: number): string {
	if (!bytes || bytes < 0) return '';
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface PreviewPanelProps {
	item: PreviewItem;
	onClose: () => void;
}

/**
 * Right-rail preview of a document, opened by clicking its mention in a task
 * comment. The document's markdown renders inline. The header carries an "open in
 * new tab" affordance — the new-tab link that used to sit on the mention itself
 * moves here. (Asset mentions no longer open here — they link straight to a new
 * tab.)
 */
export function PreviewPanel({ item, onClose }: PreviewPanelProps) {
	const docQuery = useProjectDoc(item.projectId, item.filename);
	const openUrl = docPreviewPath(item.projectSlug, item.filename);
	const meta = formatBytes(item.size);

	return (
		<aside
			data-testid="preview-panel"
			className="fixed inset-0 z-[60] flex min-h-0 flex-col overflow-hidden bg-surface lg:inset-auto lg:z-auto lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:rounded-lg lg:border lg:border-border"
		>
			<div className="flex items-center gap-2 border-b border-border bg-surface-2 px-3 py-2">
				<span
					className="min-w-0 flex-1 truncate font-mono text-[13px] text-text-1"
					title={item.filename}
					data-testid="preview-panel-filename"
				>
					{item.filename}
				</span>
				<a
					href={openUrl}
					target="_blank"
					rel="noopener noreferrer"
					className="inline-flex shrink-0 items-center gap-1 text-[11px] text-info-soft-fg hover:underline"
					data-testid="preview-open-tab"
				>
					open in new tab
					<ExternalLink className="h-3 w-3" />
				</a>
				<ReviewToolbarActions projectId={item.projectId} filename={item.filename} />
				<ReviewHelp />
				<button
					type="button"
					onClick={onClose}
					aria-label="Close preview"
					data-testid="preview-close"
					className="shrink-0 rounded-md p-1 text-text-3 transition-colors hover:bg-surface-3 hover:text-text-1"
				>
					<X className="h-4 w-4" />
				</button>
			</div>
			{meta && (
				<div className="border-b border-border px-3 py-1.5 text-[11px] text-text-3">{meta}</div>
			)}
			<div className="min-h-0 flex-1 overflow-auto">
				<PreviewBody
					item={item}
					docContent={docQuery.data?.content}
					docUpdatedAt={docQuery.data?.updated_at}
					docLoading={docQuery.isLoading}
				/>
			</div>
		</aside>
	);
}

function PreviewBody({
	item,
	docContent,
	docUpdatedAt,
	docLoading,
}: {
	item: PreviewItem;
	docContent?: string;
	docUpdatedAt?: string;
	docLoading: boolean;
}) {
	if (docLoading) return <div className="p-3 text-[13px] text-text-3">Loading…</div>;
	if (!docContent) return <div className="p-3 text-[13px] text-text-3">No content to preview.</div>;
	return (
		<div className="p-3" data-testid="preview-doc-body">
			<ReviewableDocument
				projectId={item.projectId}
				projectSlug={item.projectSlug}
				filename={item.filename}
				content={docContent}
				docUpdatedAt={docUpdatedAt}
			/>
		</div>
	);
}
