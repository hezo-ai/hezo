import { Link } from '@tanstack/react-router';
import { ExternalLink, History, Pencil, X } from 'lucide-react';
import { type ProjectDoc, useProjectDoc } from '../../hooks/use-project-docs';
import { docPreviewPath } from '../../lib/doc-preview';
import type { ReviewTaskContext } from '../document-review/action-review-dialog';
import { DocumentBody } from '../document-review/document-body';
import { ReviewToolbarActions } from '../document-review/review-toolbar-actions';
import { Tooltip } from '../ui/tooltip';
import type { PreviewItem } from './preview-context';

// Icon-button styling shared by the panel's document-level actions (edit,
// history, open-in-new-tab), so the whole header row reads as one cluster.
const ICON_ACTION_CLASSES =
	'shrink-0 rounded-md p-1 text-text-3 transition-colors hover:bg-surface-3 hover:text-text-1';

function formatBytes(bytes?: number): string {
	if (!bytes || bytes < 0) return '';
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface PreviewPanelProps {
	item: PreviewItem;
	onClose: () => void;
	/** The hosting task (task-detail surface only) — pinned first in the review dialog's "Add to task" picker. */
	task?: ReviewTaskContext;
}

/**
 * Right-rail preview of a document, opened by clicking its mention in a task
 * comment. The document's markdown renders inline. The header carries an "open in
 * new tab" affordance — the new-tab link that used to sit on the mention itself
 * moves here. (Asset mentions no longer open here — they link straight to a new
 * tab.)
 */
export function PreviewPanel({ item, onClose, task }: PreviewPanelProps) {
	const docQuery = useProjectDoc(item.projectId, item.filename);
	const openUrl = docPreviewPath(item.projectSlug, item.filename);
	const meta = formatBytes(item.size);
	// Archived docs are read-only — mirror the Documents toolbar and drop Edit
	// (History stays: past revisions are still viewable/restorable there).
	const isArchived = !!docQuery.data?.archived_at;

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
				<ReviewToolbarActions projectId={item.projectId} filename={item.filename} task={task} />
				{!isArchived && (
					<Tooltip content="Edit document">
						<Link
							to="/projects/$projectId/documents"
							params={{ projectId: item.projectSlug }}
							search={{ file: item.filename, edit: true }}
							aria-label="Edit document"
							className={ICON_ACTION_CLASSES}
							data-testid="preview-edit"
						>
							<Pencil className="h-4 w-4" />
						</Link>
					</Tooltip>
				)}
				<Tooltip content="Revision history">
					<Link
						to="/projects/$projectId/documents"
						params={{ projectId: item.projectSlug }}
						search={{ file: item.filename, history: true }}
						aria-label="Revision history"
						className={ICON_ACTION_CLASSES}
						data-testid="preview-history"
					>
						<History className="h-4 w-4" />
					</Link>
				</Tooltip>
				<Tooltip content="Open in new tab">
					<a
						href={openUrl}
						target="_blank"
						rel="noopener noreferrer"
						aria-label="Open in new tab"
						className={ICON_ACTION_CLASSES}
						data-testid="preview-open-tab"
					>
						<ExternalLink className="h-4 w-4" />
					</a>
				</Tooltip>
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
				<PreviewBody item={item} doc={docQuery.data} docLoading={docQuery.isLoading} />
			</div>
		</aside>
	);
}

function PreviewBody({
	item,
	doc,
	docLoading,
}: {
	item: PreviewItem;
	doc?: ProjectDoc;
	docLoading: boolean;
}) {
	if (docLoading) return <div className="p-3 text-[13px] text-text-3">Loading…</div>;
	if (!doc?.content)
		return <div className="p-3 text-[13px] text-text-3">No content to preview.</div>;
	return (
		<div className="p-3" data-testid="preview-doc-body">
			<DocumentBody
				projectId={item.projectId}
				projectSlug={item.projectSlug}
				content={doc.content}
				meta={{
					createdAt: doc.created_at,
					updatedAt: doc.updated_at,
					editorName: doc.last_updated_by_name,
					editorType: doc.last_updated_by_type,
					archivedAt: doc.archived_at,
					archivedByName: doc.archived_by_name,
				}}
				review={{ filename: item.filename, docUpdatedAt: doc.updated_at }}
			/>
		</div>
	);
}
