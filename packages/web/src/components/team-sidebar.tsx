import { OPERATIONS_PROJECT_SLUG } from '@hezo/shared';
import { useState } from 'react';
import { useProjects } from '../hooks/use-projects';
import { useTeam } from '../hooks/use-teams';
import { useUiState, useUpdateUiState } from '../hooks/use-ui-state';
import { CreateProjectDialog } from './create-project-dialog';
import { SidebarNav, type SidebarNavSection } from './sidebar-nav';

interface TeamSidebarProps {
	teamId: string;
}

export function TeamSidebar({ teamId }: TeamSidebarProps) {
	const params = { teamId };
	const { data: projects } = useProjects(teamId);
	const { data: team } = useTeam(teamId);
	const { data: uiState } = useUiState(teamId);
	const updateUiState = useUpdateUiState(teamId);
	const [createProjectOpen, setCreateProjectOpen] = useState(false);

	const sortedProjects = [...(projects ?? [])].sort((a, b) => {
		if (a.slug === OPERATIONS_PROJECT_SLUG) return -1;
		if (b.slug === OPERATIONS_PROJECT_SLUG) return 1;
		return a.name.localeCompare(b.name);
	});

	const projectsExpanded = uiState?.sidebar?.projects_expanded ?? true;

	const sections: SidebarNavSection[] = [
		{
			items: [{ to: '/teams/$teamId/inbox', params, label: 'Inbox' }],
		},
		{
			title: 'Work',
			items: [
				{
					to: '/teams/$teamId/issues',
					params,
					label: 'Issues',
					count: team?.open_issue_count,
					testId: 'sidebar-link-issues',
				},
				{ to: '/teams/$teamId/goals', params, label: 'Goals' },
			],
		},
		{
			title: 'Projects',
			titleTo: '/teams/$teamId/projects',
			titleParams: params,
			collapsible: true,
			collapsed: !projectsExpanded,
			onToggle: () => {
				updateUiState.mutate({ sidebar: { projects_expanded: !projectsExpanded } });
			},
			onAdd: () => setCreateProjectOpen(true),
			addLabel: 'Create a new project',
			items: [],
			children: sortedProjects.map((project) => {
				const projectParams = { teamId, projectId: project.slug };
				return {
					to: '/teams/$teamId/projects/$projectId',
					params: projectParams,
					label: project.name,
					subItems: [
						{
							to: '/teams/$teamId/projects/$projectId/issues',
							params: projectParams,
							label: 'Issues',
							count: project.open_issue_count,
						},
						{
							to: '/teams/$teamId/projects/$projectId/documents',
							params: projectParams,
							label: 'Documents',
						},
						{
							to: '/teams/$teamId/projects/$projectId/container',
							params: projectParams,
							label: 'Container',
						},
						{
							to: '/teams/$teamId/projects/$projectId/settings',
							params: projectParams,
							label: 'Settings',
						},
					],
				};
			}),
		},
		{
			items: [{ to: '/teams/$teamId/agents', params, label: 'Team' }],
		},
		{
			title: 'Resources',
			items: [{ to: '/teams/$teamId/kb', params, label: 'Knowledge base' }],
		},
		{
			title: 'Settings',
			items: [
				{ to: '/teams/$teamId/settings/general', params, label: 'General' },
				{ to: '/teams/$teamId/settings/connections', params, label: 'Connections' },
				{ to: '/teams/$teamId/settings/credentials', params, label: 'Credentials' },
				{ to: '/teams/$teamId/settings/audit-log', params, label: 'Audit log' },
			],
		},
	];

	return (
		<>
			<SidebarNav sections={sections} />
			<CreateProjectDialog
				teamId={teamId}
				open={createProjectOpen}
				onOpenChange={setCreateProjectOpen}
			/>
		</>
	);
}
