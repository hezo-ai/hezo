import { Link, useParams } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useCompanies } from '../hooks/use-companies';
import { CreateCompanyDialog } from './create-company-dialog';
import { Avatar, avatarColorFromString } from './ui/avatar';

function getInitials(name: string): string {
	const words = name.split(/\s+/);
	if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
	return name.slice(0, 2).toUpperCase();
}

export function CompanyRail() {
	const { data: companies } = useCompanies();
	const params = useParams({ strict: false });
	const activeCompanyId = (params as Record<string, string>).companyId;
	const [createOpen, setCreateOpen] = useState(false);

	return (
		<aside className="w-[60px] shrink-0 border-r border-border bg-bg-subtle flex flex-col items-center py-3 gap-2 overflow-y-auto">
			{companies?.map((company) => {
				const isActive = company.id === activeCompanyId;
				return (
					<Link
						key={company.id}
						to="/companies/$companyId/issues"
						params={{ companyId: company.id }}
						className={`relative group ${isActive ? '' : 'opacity-60 hover:opacity-100'} transition-opacity`}
						title={company.name}
					>
						{isActive && (
							<span className="absolute -left-[10px] top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-full bg-primary" />
						)}
						<Avatar
							initials={getInitials(company.name)}
							size="md"
							color={avatarColorFromString(company.name)}
							className={isActive ? 'ring-2 ring-primary ring-offset-2 ring-offset-bg-subtle' : ''}
						/>
					</Link>
				);
			})}
			<button
				type="button"
				onClick={() => setCreateOpen(true)}
				className="mt-1 w-[36px] h-[36px] rounded-full border border-dashed border-border-hover flex items-center justify-center text-text-subtle hover:text-text hover:border-text-muted transition-colors cursor-pointer"
				title="New company"
			>
				<Plus className="w-4 h-4" />
			</button>
			<CreateCompanyDialog open={createOpen} onOpenChange={setCreateOpen} />
		</aside>
	);
}
