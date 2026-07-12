import { createFileRoute, Link } from '@tanstack/react-router';
import { History, Pencil } from 'lucide-react';
import { useState } from 'react';
import { DocumentBody } from '../../../components/document-review/document-body';
import { ReviewToolbarActions } from '../../../components/document-review/review-toolbar-actions';
import { ScrollToBottomButton } from '../../../components/scroll-to-bottom-button';
import { Tooltip } from '../../../components/ui/tooltip';
import { useProjectDoc } from '../../../hooks/use-project-docs';
import { useScrollToBottom } from '../../../hooks/use-scroll-to-bottom';

// Matches the icon-button styling on the task-detail preview panel so the
// document-level actions read consistently across both preview surfaces.
const ICON_ACTION_CLASSES =
	'shrink-0 rounded-md p-1 text-text-3 transition-colors hover:bg-surface-3 hover:text-text-1';

function DocPreviewPage() {
	const { projectId, filename } = Route.useParams();
	const { data: doc, isLoading, isError } = useProjectDoc(projectId, filename);
	// This bare route renders outside the app shell, so it carries its own
	// scroll-to-bottom pill wired to its own full-viewport scroller.
	const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
	const { visible: bottomVisible, scrollToBottom } = useScrollToBottom(scroller);

	if (isLoading) {
		return <CenteredMessage>Loading…</CenteredMessage>;
	}

	if (isError || doc?.content == null) {
		return <CenteredMessage>Document not found.</CenteredMessage>;
	}

	return (
		<div
			ref={setScroller}
			data-testid="preview-scroller"
			className="h-screen overflow-auto bg-surface"
		>
			{/* Full-width sticky bar spanning the content column: filename left,
			    actions right. `border-b` + translucent blur lets the doc scroll
			    cleanly underneath. */}
			<div className="sticky top-0 z-10 border-b border-border bg-surface/85 backdrop-blur-md">
				<div
					className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-2.5 sm:px-6 lg:px-8"
					data-testid="preview-review-toolbar"
				>
					<span
						className="min-w-0 flex-1 truncate font-mono text-[13px] text-text-1"
						title={filename}
					>
						{filename}
					</span>
					<div className="flex shrink-0 items-center gap-1">
						<ReviewToolbarActions projectId={projectId} filename={filename} variant="inline" />
						{/* Archived docs are read-only — mirror the Documents toolbar and drop
						    Edit while keeping History. */}
						{!doc.archived_at && (
							<Tooltip content="Edit document">
								<Link
									to="/projects/$projectId/documents"
									params={{ projectId }}
									search={{ file: filename, edit: true }}
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
								params={{ projectId }}
								search={{ file: filename, history: true }}
								aria-label="Revision history"
								className={ICON_ACTION_CLASSES}
								data-testid="preview-history"
							>
								<History className="h-4 w-4" />
							</Link>
						</Tooltip>
					</div>
				</div>
			</div>
			{/* pt-4 (was py-8) tightens the gap between the top bar and the metadata banner. */}
			<div className="max-w-3xl mx-auto px-4 pt-4 pb-8 sm:px-6 lg:px-8">
				<DocumentBody
					projectId={projectId}
					projectSlug={projectId}
					content={doc.content || '_(empty)_'}
					meta={{
						createdAt: doc.created_at,
						updatedAt: doc.updated_at,
						editorName: doc.last_updated_by_name,
						editorType: doc.last_updated_by_type,
						archivedAt: doc.archived_at,
						archivedByName: doc.archived_by_name,
					}}
					review={{ filename, docUpdatedAt: doc.updated_at }}
				/>
			</div>
			<ScrollToBottomButton
				onClick={scrollToBottom}
				visible={bottomVisible}
				testId="scroll-to-bottom"
				positionClassName="fixed bottom-4 left-1/2 -translate-x-1/2 z-30"
			/>
		</div>
	);
}

function CenteredMessage({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex items-center justify-center h-screen text-text-2 text-[13px]">
			{children}
		</div>
	);
}

export const Route = createFileRoute('/preview/$projectId/$filename')({
	staticData: { bare: true },
	component: DocPreviewPage,
});
