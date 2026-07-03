import { createFileRoute } from '@tanstack/react-router';
import { DocumentBody } from '../../../components/document-review/document-body';
import { ReviewToolbarActions } from '../../../components/document-review/review-toolbar-actions';
import { useProjectDoc } from '../../../hooks/use-project-docs';

function DocPreviewPage() {
	const { projectId, filename } = Route.useParams();
	const { data: doc, isLoading, isError } = useProjectDoc(projectId, filename);

	if (isLoading) {
		return <CenteredMessage>Loading…</CenteredMessage>;
	}

	if (isError || doc?.content == null) {
		return <CenteredMessage>Document not found.</CenteredMessage>;
	}

	return (
		<div className="h-screen overflow-auto bg-surface">
			<div className="sticky top-0 z-10 flex items-center justify-center gap-2 px-4 pt-3">
				<div
					className="flex items-center gap-2 rounded-[10px] border border-border bg-surface/85 px-2.5 py-1 shadow-sm backdrop-blur-md"
					data-testid="preview-review-toolbar"
				>
					<span
						className="max-w-[45vw] truncate font-mono text-[13px] text-text-1"
						title={filename}
					>
						{filename}
					</span>
					<span className="h-4 w-px shrink-0 bg-border" aria-hidden />
					<ReviewToolbarActions projectId={projectId} filename={filename} variant="inline" />
				</div>
			</div>
			<div className="max-w-3xl mx-auto px-4 py-8 sm:px-6 lg:px-8">
				<DocumentBody
					projectId={projectId}
					projectSlug={projectId}
					content={doc.content || '_(empty)_'}
					meta={{
						createdAt: doc.created_at,
						updatedAt: doc.updated_at,
						editorName: doc.last_updated_by_name,
						editorType: doc.last_updated_by_type,
					}}
					review={{ filename, docUpdatedAt: doc.updated_at }}
				/>
			</div>
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
