import { createFileRoute, Link } from '@tanstack/react-router';
import { Building2, Plus } from 'lucide-react';
import { useState } from 'react';
import { CreateCompanyDialog } from '../../components/create-company-dialog';
import { Avatar, avatarColorFromString } from '../../components/ui/avatar';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { EmptyState } from '../../components/ui/empty-state';
import { useCompanies } from '../../hooks/use-companies';

function getInitials(name: string): string {
	const words = name.split(/\s+/);
	if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
	return name.slice(0, 2).toUpperCase();
}

function CompanyListPage() {
	const { data: companies, isLoading } = useCompanies();
	const [createOpen, setCreateOpen] = useState(false);

	if (isLoading) {
		return <div className="p-8 text-text-muted">Loading...</div>;
	}

	return (
		<div className="max-w-[900px] mx-auto w-full px-8 py-6">
			<div className="flex items-center justify-between mb-5">
				<h1 className="text-[22px] font-medium">Companies</h1>
				<Button onClick={() => setCreateOpen(true)}>
					<Plus className="w-4 h-4" />
					New company
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
				<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
					{companies?.map((company) => (
						<Link key={company.id} to="/companies/$companyId" params={{ companyId: company.id }}>
							<Card className="cursor-pointer">
								<div className="flex items-start gap-3">
									<Avatar
										initials={getInitials(company.name)}
										color={avatarColorFromString(company.name)}
									/>
									<div className="flex flex-col gap-1 min-w-0">
										<h2 className="text-[15px] font-medium text-text truncate">{company.name}</h2>
										{company.description && (
											<p className="text-xs text-text-muted line-clamp-2">{company.description}</p>
										)}
										<div className="flex gap-3 text-xs text-text-muted mt-1">
											<span>{company.agent_count} agents</span>
											<span>{company.open_issue_count} issues</span>
										</div>
									</div>
								</div>
							</Card>
						</Link>
					))}
				</div>
			)}

			<CreateCompanyDialog open={createOpen} onOpenChange={setCreateOpen} />
		</div>
	);
}

export const Route = createFileRoute('/companies/')({
	component: CompanyListPage,
});
