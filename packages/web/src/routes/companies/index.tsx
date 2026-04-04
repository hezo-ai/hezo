import { createFileRoute, Link } from '@tanstack/react-router';
import { Building2, Plus } from 'lucide-react';
import { Avatar, avatarColorFromString } from '../../components/ui/avatar';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { useCompanies } from '../../hooks/use-companies';

function getInitials(name: string): string {
	const words = name.split(/\s+/);
	if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
	return name.slice(0, 2).toUpperCase();
}

function CompanyListPage() {
	const { data: companies, isLoading } = useCompanies();

	if (isLoading) {
		return <div className="p-8 text-text-muted">Loading...</div>;
	}

	if (companies?.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center h-[70vh] gap-6">
				<Building2 className="w-16 h-16 text-text-muted" />
				<div className="text-center">
					<h1 className="text-2xl font-semibold mb-2">Welcome to Hezo</h1>
					<p className="text-text-muted">Create your first company to get started.</p>
				</div>
				<Link to="/companies/new">
					<Button>
						<Plus className="w-4 h-4" />
						Create Company
					</Button>
				</Link>
			</div>
		);
	}

	return (
		<div className="max-w-[900px] mx-auto w-full px-8 py-6">
			<div className="flex items-center justify-between mb-5">
				<h1 className="text-[22px] font-medium">Companies</h1>
				<Link to="/companies/new">
					<Button>
						<Plus className="w-4 h-4" />
						New company
					</Button>
				</Link>
			</div>

			<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
				{companies?.map((company) => (
					<Link key={company.id} to="/companies/$companyId" params={{ companyId: company.slug }}>
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
		</div>
	);
}

export const Route = createFileRoute('/companies/')({
	component: CompanyListPage,
});
