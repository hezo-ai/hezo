import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { Home, Inbox, Plus, Settings } from 'lucide-react';
import { useAllPendingApprovals } from '../hooks/use-approvals';
import { useCompanies } from '../hooks/use-companies';
import { useAllNotifications } from '../hooks/use-notifications';
import { Avatar, avatarColorFromString } from './ui/avatar';
import { ThemeSwitcher } from './ui/theme-switcher';

function getInitials(name: string): string {
	const words = name.split(/\s+/);
	if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
	return name.slice(0, 2).toUpperCase();
}

export function CompanyRail() {
	const { data: companies } = useCompanies();
	const params = useParams({ strict: false });
	const activeCompanyId = (params as Record<string, string>).companyId;
	const navigate = useNavigate();
	const companySlugs = companies?.map((c) => c.slug) ?? [];
	const approvalsQuery = useAllPendingApprovals(companySlugs);
	const notificationsQuery = useAllNotifications(companySlugs, { unreadOnly: true });
	const pendingCount = (approvalsQuery.data?.length ?? 0) + (notificationsQuery.data?.length ?? 0);

	return (
		<aside className="w-[60px] shrink-0 border-r border-border bg-bg-subtle flex flex-col items-center py-3 gap-2 overflow-y-auto">
			<Link
				to="/companies"
				className="w-[36px] h-[36px] rounded-full flex items-center justify-center text-text-muted hover:text-text hover:bg-bg-muted transition-colors"
				title="Home"
			>
				<Home className="w-4 h-4" />
			</Link>

			<div className="w-8 border-t border-border my-1" />

			{companies?.map((company) => {
				const isActive = company.slug === activeCompanyId;
				return (
					<Link
						key={company.id}
						to="/companies/$companyId"
						params={{ companyId: company.slug }}
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
				onClick={() => navigate({ to: '/companies/new' })}
				className="mt-1 w-[36px] h-[36px] rounded-full border border-dashed border-border-hover flex items-center justify-center text-text-subtle hover:text-text hover:border-text-muted transition-colors cursor-pointer"
				title="New company"
			>
				<Plus className="w-4 h-4" />
			</button>

			<div className="mt-auto flex flex-col items-center gap-1 pt-2">
				<ThemeSwitcher />
				<Link
					to="/settings"
					className="inline-flex items-center justify-center w-8 h-8 rounded-radius-md text-text-muted hover:text-text hover:bg-bg-muted transition-colors"
					title="Settings"
				>
					<Settings className="w-4 h-4" />
				</Link>
				<Link
					to="/inbox"
					className="relative inline-flex items-center justify-center w-8 h-8 rounded-radius-md text-text-muted hover:text-text hover:bg-bg-muted transition-colors"
					title="Inbox"
				>
					<Inbox className="w-4 h-4" />
					{pendingCount > 0 && (
						<span className="absolute -top-1 -right-1 flex items-center justify-center w-4 h-4 rounded-full bg-accent-red text-white text-[10px] font-bold">
							{pendingCount}
						</span>
					)}
				</Link>
			</div>
		</aside>
	);
}
