import { createFileRoute, Link } from '@tanstack/react-router';
import { Building2, Plus } from 'lucide-react';
import { useState } from 'react';
import { CreateCompanyDialog } from '../../components/create-company-dialog';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { EmptyState } from '../../components/ui/empty-state';
import { useCompanies } from '../../hooks/use-companies';

function CompanyListPage() {
	const { data: companies, isLoading } = useCompanies();
	const [createOpen, setCreateOpen] = useState(false);

	if (isLoading) {
		return <div className="p-8 text-text-muted">Loading...</div>;
	}

	return (
		<div className="flex-1 p-8 overflow-auto">
			<div className="max-w-5xl mx-auto">
				<div className="flex items-center justify-between mb-6">
					<h1 className="text-xl font-semibold">Companies</h1>
					<Button onClick={() => setCreateOpen(true)}>
						<Plus className="w-4 h-4" />
						New Company
					</Button>
				</div>

				{companies?.length === 0 ? (
					<EmptyState
						icon={<Building2 className="w-10 h-10" />}
						title="No companies yet"
						description="Create your first company to get started."
						action={
							<Button onClick={() => setCreateOpen(true)}>
								<Plus className="w-4 h-4" />
								Create Company
							</Button>
						}
					/>
				) : (
					<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
						{companies?.map((company) => (
							<Link key={company.id} to="/companies/$companyId" params={{ companyId: company.id }}>
								<Card className="hover:border-primary/50 transition-colors cursor-pointer">
									<div className="flex flex-col gap-2">
										<h2 className="font-medium text-text">{company.name}</h2>
										{company.mission && (
											<p className="text-xs text-text-muted line-clamp-2">{company.mission}</p>
										)}
										<div className="flex gap-2 mt-1">
											<Badge color="blue">{company.agent_count} agents</Badge>
											<Badge color="yellow">{company.open_issue_count} open issues</Badge>
										</div>
									</div>
								</Card>
							</Link>
						))}
					</div>
				)}

				<CreateCompanyDialog open={createOpen} onOpenChange={setCreateOpen} />
			</div>
		</div>
	);
}

export const Route = createFileRoute('/companies/')({
	component: CompanyListPage,
});
