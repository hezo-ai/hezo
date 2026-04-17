import { AgentAdminStatus } from '@hezo/shared';
import { useState } from 'react';
import { useAgents } from '../hooks/use-agents';
import { useProjects } from '../hooks/use-projects';
import { useUiState, useUpdateUiState } from '../hooks/use-ui-state';
import { AgentStatusLabel } from './agent-status-label';
import { CreateProjectDialog } from './create-project-dialog';
import { SidebarNav, type SidebarNavSection } from './sidebar-nav';

interface CompanySidebarProps {
	companyId: string;
}

export function CompanySidebar({ companyId }: CompanySidebarProps) {
	const params = { companyId };
	const { data: agents } = useAgents(companyId);
	const { data: projects } = useProjects(companyId);
	const { data: uiState } = useUiState(companyId);
	const updateUiState = useUpdateUiState(companyId);
	const [createProjectOpen, setCreateProjectOpen] = useState(false);

	const activeAgents = (agents ?? [])
		.filter((a) => a.admin_status !== AgentAdminStatus.Disabled)
		.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

	const sortedProjects = [...(projects ?? [])].sort((a, b) => {
		if (a.name.toLowerCase() === 'operations') return -1;
		if (b.name.toLowerCase() === 'operations') return 1;
		return a.name.localeCompare(b.name);
	});

	const teamExpanded = uiState?.sidebar?.team_expanded ?? true;
	const projectsExpanded = uiState?.sidebar?.projects_expanded ?? true;

	const sections: SidebarNavSection[] = [
		{
			items: [{ to: '/companies/$companyId/inbox', params, label: 'Inbox' }],
		},
		{
			title: 'Work',
			items: [
				{ to: '/companies/$companyId/issues', params, label: 'Issues' },
				{ to: '/companies/$companyId/goals', params, label: 'Goals' },
			],
		},
		{
			title: 'Projects',
			titleTo: '/companies/$companyId/projects',
			titleParams: params,
			collapsible: true,
			collapsed: !projectsExpanded,
			onToggle: () => {
				updateUiState.mutate({ sidebar: { projects_expanded: !projectsExpanded } });
			},
			onAdd: () => setCreateProjectOpen(true),
			addLabel: 'New project',
			items: [],
			children: sortedProjects.map((project) => ({
				to: '/companies/$companyId/projects/$projectId',
				params: { companyId, projectId: project.slug },
				label: project.name,
			})),
		},
		{
			title: 'Team',
			collapsible: true,
			collapsed: !teamExpanded,
			onToggle: () => {
				updateUiState.mutate({ sidebar: { team_expanded: !teamExpanded } });
			},
			items: [],
			children: activeAgents.map((agent) => ({
				to: '/companies/$companyId/agents/$agentId',
				params: { companyId, agentId: agent.id },
				label: <AgentStatusLabel name={agent.title} runtimeStatus={agent.runtime_status} />,
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

	return (
		<>
			<SidebarNav sections={sections} />
			<CreateProjectDialog
				companyId={companyId}
				open={createProjectOpen}
				onOpenChange={setCreateProjectOpen}
			/>
		</>
	);
}
