import { Tabs } from './ui/tabs';

interface CompanyTabsProps {
	companyId: string;
	issueCounts?: { total?: number };
	agentCount?: number;
	projectCount?: number;
}

export function CompanyTabs({
	companyId,
	issueCounts,
	agentCount,
	projectCount,
}: CompanyTabsProps) {
	const params = { companyId };

	return (
		<Tabs
			items={[
				{
					to: '/companies/$companyId/issues',
					params,
					label: 'Issues',
					count: issueCounts?.total,
				},
				{
					to: '/companies/$companyId/agents',
					params,
					label: 'Agents',
					count: agentCount,
				},
				{
					to: '/companies/$companyId/projects',
					params,
					label: 'Projects',
					count: projectCount,
				},
				{ to: '/companies/$companyId/org-chart', params, label: 'Org chart' },
				{ to: '/companies/$companyId/kb', params, label: 'Knowledge base' },
				{ to: '/companies/$companyId/settings', params, label: 'Settings' },
			]}
		/>
	);
}
