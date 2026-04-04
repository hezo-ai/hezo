import { SidebarNav, type SidebarNavSection } from './sidebar-nav';

interface CompanySidebarProps {
	companyId: string;
}

export function CompanySidebar({ companyId }: CompanySidebarProps) {
	const params = { companyId };

	const sections: SidebarNavSection[] = [
		{
			items: [{ to: '/companies/$companyId/inbox', params, label: 'Inbox' }],
		},
		{
			title: 'Work',
			items: [
				{ to: '/companies/$companyId/issues', params, label: 'Issues' },
				{ to: '/companies/$companyId/projects', params, label: 'Projects' },
			],
		},
		{
			title: 'Team',
			items: [
				{ to: '/companies/$companyId/agents', params, label: 'Agents' },
				{ to: '/companies/$companyId/org-chart', params, label: 'Org chart' },
			],
		},
		{
			title: 'Resources',
			items: [
				{ to: '/companies/$companyId/kb', params, label: 'Knowledge base' },
				{ to: '/companies/$companyId/settings', params, label: 'Settings' },
			],
		},
	];

	return <SidebarNav sections={sections} />;
}
