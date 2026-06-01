import { createFileRoute } from '@tanstack/react-router';
import { HtmlPreview } from '../../../../components/html-preview';
import { MarkdownProse } from '../../../../components/markdown-prose';
import { useProjectDoc } from '../../../../hooks/use-project-docs';

function DocPreviewPage() {
	const { teamId, projectId, filename } = Route.useParams();
	const { data: doc, isLoading, isError } = useProjectDoc(teamId, projectId, filename);
	const isHtml = /\.html?$/i.test(filename);

	if (isLoading) {
		return <CenteredMessage>Loading…</CenteredMessage>;
	}

	if (isError || doc?.content == null) {
		return <CenteredMessage>Document not found.</CenteredMessage>;
	}

	if (isHtml) {
		return <HtmlPreview html={doc.content} title={filename} fill />;
	}

	return (
		<div className="h-screen overflow-auto bg-bg">
			<div className="max-w-3xl mx-auto px-4 py-8 sm:px-6 lg:px-8">
				<MarkdownProse teamId={teamId} projectSlug={projectId}>
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

export const Route = createFileRoute('/preview/$teamId/$projectId/$filename')({
	staticData: { bare: true },
	component: DocPreviewPage,
});
