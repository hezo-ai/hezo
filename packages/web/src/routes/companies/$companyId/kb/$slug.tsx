import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Clock, Edit, Trash2 } from 'lucide-react';
import { useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '../../../../components/ui/button';
import { Card } from '../../../../components/ui/card';
import { useDeleteKbDoc, useKbDoc, useKbDocRevisions } from '../../../../hooks/use-kb-docs';

function KbDocViewPage() {
	const { companyId, slug } = Route.useParams();
	const { data: doc, isLoading } = useKbDoc(companyId, slug);
	const { data: revisions } = useKbDocRevisions(companyId, slug);
	const deleteDoc = useDeleteKbDoc(companyId);
	const navigate = useNavigate();
	const [showHistory, setShowHistory] = useState(false);

	if (isLoading || !doc) return <div className="p-6 text-text-muted">Loading...</div>;

	return (
		<div className="p-6 max-w-3xl">
			<Link
				to="/companies/$companyId/kb"
				params={{ companyId }}
				className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text mb-4"
			>
				<ArrowLeft className="w-3.5 h-3.5" /> Knowledge Base
			</Link>

			<div className="flex items-center justify-between mb-4">
				<h1 className="text-lg font-semibold">{doc.title}</h1>
				<div className="flex gap-2">
					<Button
						variant="ghost"
						size="sm"
						onClick={() => setShowHistory(!showHistory)}
						className={showHistory ? 'text-primary' : ''}
					>
						<Clock className="w-3.5 h-3.5" /> History
					</Button>
					<Link to="/companies/$companyId/kb/$slug/edit" params={{ companyId, slug }}>
						<Button variant="ghost" size="sm">
							<Edit className="w-3.5 h-3.5" /> Edit
						</Button>
					</Link>
					<Button
						variant="ghost"
						size="sm"
						className="text-danger"
						onClick={async () => {
							if (confirm('Delete this document?')) {
								await deleteDoc.mutateAsync(slug);
								navigate({ to: '/companies/$companyId/kb', params: { companyId } });
							}
						}}
					>
						<Trash2 className="w-3.5 h-3.5" />
					</Button>
				</div>
			</div>

			{showHistory && (
				<div className="mb-6 space-y-2">
					<h3 className="text-sm font-medium text-text-muted">Revision History</h3>
					{!revisions?.length ? (
						<p className="text-xs text-text-muted">No revisions yet.</p>
					) : (
						revisions.map((rev) => (
							<Card key={rev.id} className="p-3">
								<div className="flex items-center gap-2 mb-1">
									<span className="text-xs font-medium text-text">Rev {rev.revision_number}</span>
									<span className="text-xs text-text-muted">{rev.author_name || 'Board'}</span>
									<span className="text-xs text-text-subtle ml-auto">
										{new Date(rev.created_at).toLocaleString()}
									</span>
								</div>
								{rev.change_summary && (
									<p className="text-xs text-text-muted">{rev.change_summary}</p>
								)}
							</Card>
						))
					)}
				</div>
			)}

			<div className="prose prose-invert prose-sm max-w-none text-text [&_a]:text-primary [&_h1]:text-text [&_h2]:text-text [&_h3]:text-text [&_strong]:text-text [&_code]:text-primary [&_code]:bg-bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_pre]:bg-bg-muted [&_pre]:border [&_pre]:border-border">
				<Markdown remarkPlugins={[remarkGfm]}>{doc.content ?? ''}</Markdown>
			</div>
		</div>
	);
}

export const Route = createFileRoute('/companies/$companyId/kb/$slug')({
	component: KbDocViewPage,
});
