import { createFileRoute, Link } from '@tanstack/react-router';
import { BookOpen, Plus } from 'lucide-react';
import { Badge } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';
import { EmptyState } from '../../../../components/ui/empty-state';
import { useKbDocs } from '../../../../hooks/use-kb-docs';

function KbListPage() {
	const { companyId } = Route.useParams();
	const { data: docs, isLoading } = useKbDocs(companyId);

	if (isLoading)
		return <div className="text-text-muted text-[13px] py-8 text-center">Loading...</div>;

	return (
		<div>
			<div className="flex items-center justify-end mb-4">
				<Link to="/companies/$companyId/kb/new" params={{ companyId }}>
					<Button>
						<Plus className="w-4 h-4" /> New document
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
				<div className="flex flex-col">
					{docs?.map((doc) => (
						<Link
							key={doc.id}
							to="/companies/$companyId/kb/$slug"
							params={{ companyId, slug: doc.slug }}
						>
							<div className="flex items-center justify-between py-3 px-2 -mx-2 border-b border-border rounded-radius-md transition-colors hover:bg-bg-subtle cursor-pointer">
								<div>
									<div className="flex items-center gap-2 mb-0.5">
										<span className="text-sm font-medium">{doc.title}</span>
										{doc.title.endsWith('.md') && <Badge color="info">System</Badge>}
									</div>
									<div className="text-xs text-text-muted leading-relaxed">
										{doc.last_updated_by_name && (
											<span>Updated by {doc.last_updated_by_name} · </span>
										)}
										{new Date(doc.updated_at).toLocaleDateString()}
									</div>
								</div>
							</div>
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
