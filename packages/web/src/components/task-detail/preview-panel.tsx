import { ExternalLink, X } from 'lucide-react';
import { useProjectDoc } from '../../hooks/use-project-docs';
import { docPreviewPath } from '../../lib/doc-preview';
import { MarkdownProse } from '../markdown-prose';
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
 * Right-rail preview of a document or asset, opened by clicking its mention in a
 * task comment. Documents render their markdown inline; assets render by MIME
 * type (image / embeddable iframe), with a fallback for everything else. The
 * header carries an "open in new tab" affordance — the new-tab link that used to
 * sit on the mention itself moves here.
 */
export function PreviewPanel({ item, onClose }: PreviewPanelProps) {
	const isDoc = item.kind === 'doc';
	const docQuery = useProjectDoc(item.projectId, isDoc ? item.filename : null);
	const openUrl = isDoc ? docPreviewPath(item.projectSlug, item.filename) : (item.url ?? '');
	const meta = formatBytes(item.size);

	return (
		<aside
			data-testid="preview-panel"
			className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-surface lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)]"
		>
			<div className="flex items-center gap-2 border-b border-border bg-surface-2 px-3 py-2">
				<span
					className="min-w-0 flex-1 truncate font-mono text-[13px] text-text-1"
					title={item.filename}
					data-testid="preview-panel-filename"
				>
					{item.filename}
				</span>
				{openUrl && (
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
				)}
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
					docLoading={isDoc && docQuery.isLoading}
				/>
			</div>
		</aside>
	);
}

function PreviewBody({
	item,
	docContent,
	docLoading,
}: {
	item: PreviewItem;
	docContent?: string;
	docLoading: boolean;
}) {
	if (item.kind === 'doc') {
		if (docLoading) return <div className="p-3 text-[13px] text-text-3">Loading…</div>;
		if (!docContent)
			return <div className="p-3 text-[13px] text-text-3">No content to preview.</div>;
		return (
			<div className="p-3" data-testid="preview-doc-body">
				<MarkdownProse projectId={item.projectId} projectSlug={item.projectSlug}>
					{docContent}
				</MarkdownProse>
			</div>
		);
	}

	const contentType = item.contentType ?? '';
	if (!item.url) return <div className="p-3 text-[13px] text-text-3">No preview available.</div>;
	if (contentType.startsWith('image/')) {
		// biome-ignore lint/a11y/useAltText: filename is the best available description
		return (
			<img src={item.url} alt={item.filename} className="w-full" data-testid="preview-image" />
		);
	}
	if (contentType === 'text/html' || contentType === 'application/pdf') {
		return (
			<iframe
				src={item.url}
				title={item.filename}
				sandbox=""
				className="h-[60vh] w-full bg-surface"
				data-testid="preview-iframe"
			/>
		);
	}
	return (
		<div className="p-3 text-[13px] text-text-3">
			No inline preview for this file type — use “open in new tab”.
		</div>
	);
}
