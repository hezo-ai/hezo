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
			items: [{ to: '/companies/$companyId/agents', params, label: 'Team' }],
		},
		{
			title: 'Resources',
			items: [
				{ to: '/companies/$companyId/kb', params, label: 'Knowledge base' },
				{ to: '/companies/$companyId/settings', params, label: 'Settings' },
				{ to: '/companies/$companyId/audit-log', params, label: 'Audit log' },
			],
		},
	];

	return <SidebarNav sections={sections} />;
}
