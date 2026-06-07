import { createFileRoute } from '@tanstack/react-router';
import { MarkdownProse } from '../../../components/markdown-prose';
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
		<div className="h-screen overflow-auto bg-bg">
			<div className="max-w-3xl mx-auto px-4 py-8 sm:px-6 lg:px-8">
				<MarkdownProse projectId={projectId} projectSlug={projectId}>
					{doc.content || '_(empty)_'}
				</MarkdownProse>
			</div>
		</div>
	);
}

function CenteredMessage({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex items-center justify-center h-screen text-text-muted text-[13px]">
			{children}
		</div>
	);
}

export const Route = createFileRoute('/preview/$projectId/$filename')({
	staticData: { bare: true },
	component: DocPreviewPage,
});
