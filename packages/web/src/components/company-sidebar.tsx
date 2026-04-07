import { AgentAdminStatus } from '@hezo/shared';
import { useAgents } from '../hooks/use-agents';
import { useUiState, useUpdateUiState } from '../hooks/use-ui-state';
import { SidebarNav, type SidebarNavSection } from './sidebar-nav';

interface CompanySidebarProps {
	companyId: string;
}

export function CompanySidebar({ companyId }: CompanySidebarProps) {
	const params = { companyId };
	const { data: agents } = useAgents(companyId);
	const { data: uiState } = useUiState(companyId);
	const updateUiState = useUpdateUiState(companyId);

	const activeAgents = (agents ?? [])
		.filter((a) => a.admin_status !== AgentAdminStatus.Terminated)
		.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

	const teamExpanded = uiState?.sidebar?.team_expanded ?? true;

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
			collapsible: true,
			collapsed: !teamExpanded,
			onToggle: () => {
				updateUiState.mutate({ sidebar: { team_expanded: !teamExpanded } });
			},
			items: [{ to: '/companies/$companyId/agents', params, label: 'All agents' }],
			children: activeAgents.map((agent) => ({
				to: '/companies/$companyId/agents/$agentId',
				params: { companyId, agentId: agent.id },
				label: agent.title,
			})),
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
