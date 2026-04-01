import { createFileRoute, Link } from '@tanstack/react-router';
import { BookOpen, Plus } from 'lucide-react';
import { Button } from '../../../../components/ui/button';
import { Card } from '../../../../components/ui/card';
import { EmptyState } from '../../../../components/ui/empty-state';
import { useKbDocs } from '../../../../hooks/use-kb-docs';

function KbListPage() {
	const { companyId } = Route.useParams();
	const { data: docs, isLoading } = useKbDocs(companyId);

	if (isLoading) return <div className="p-6 text-text-muted">Loading...</div>;

	return (
		<div className="p-6">
			<div className="flex items-center justify-between mb-4">
				<h1 className="text-lg font-semibold">Knowledge Base</h1>
				<Link to="/companies/$companyId/kb/new" params={{ companyId }}>
					<Button size="sm">
						<Plus className="w-4 h-4" /> New Doc
					</Button>
				</Link>
			</div>

			{docs?.length === 0 ? (
				<EmptyState
					icon={<BookOpen className="w-10 h-10" />}
					title="No documents yet"
					description="Create knowledge base documents for your agents."
				/>
			) : (
				<div className="flex flex-col gap-2">
					{docs?.map((doc) => (
						<Link
							key={doc.id}
							to="/companies/$companyId/kb/$slug"
							params={{ companyId, slug: doc.slug }}
						>
							<Card className="hover:border-primary/50 transition-colors cursor-pointer p-3">
								<div className="flex items-center justify-between">
									<h3 className="font-medium text-sm">{doc.title}</h3>
									<span className="text-xs text-text-subtle">
										{new Date(doc.updated_at).toLocaleDateString()}
									</span>
								</div>
								{doc.last_updated_by_name && (
									<span className="text-xs text-text-subtle">
										Updated by {doc.last_updated_by_name}
									</span>
								)}
							</Card>
						</Link>
					))}
				</div>
			)}
		</div>
	);
}

export const Route = createFileRoute('/companies/$companyId/kb/')({
	component: KbListPage,
});
