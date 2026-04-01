import { Link, useMatchRoute } from '@tanstack/react-router';
import { BookOpen, FolderKanban, GitFork, LayoutList, Settings, Users } from 'lucide-react';

const navItems = [
	{ to: '/companies/$companyId/issues', label: 'Issues', icon: LayoutList },
	{ to: '/companies/$companyId/agents', label: 'Agents', icon: Users },
	{ to: '/companies/$companyId/projects', label: 'Projects', icon: FolderKanban },
	{ to: '/companies/$companyId/org-chart', label: 'Org Chart', icon: GitFork },
	{ to: '/companies/$companyId/kb', label: 'Knowledge Base', icon: BookOpen },
	{ to: '/companies/$companyId/settings', label: 'Settings', icon: Settings },
] as const;

interface SidebarProps {
	companyId: string;
}

export function Sidebar({ companyId }: SidebarProps) {
	const matchRoute = useMatchRoute();

	return (
		<nav className="flex flex-col gap-0.5 p-2">
			{navItems.map((item) => {
				const Icon = item.icon;
				const isActive = matchRoute({ to: item.to, params: { companyId }, fuzzy: true });
				return (
					<Link
						key={item.to}
						to={item.to}
						params={{ companyId }}
						className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors ${
							isActive
								? 'bg-bg-muted text-text font-medium'
								: 'text-text-muted hover:text-text hover:bg-bg-muted/50'
						}`}
					>
						<Icon className="w-4 h-4" />
						{item.label}
					</Link>
				);
			})}
		</nav>
	);
}
