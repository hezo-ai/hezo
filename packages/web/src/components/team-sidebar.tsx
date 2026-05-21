import { AgentAdminStatus, OPERATIONS_PROJECT_SLUG } from '@hezo/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { Settings } from 'lucide-react';
import { useState } from 'react';
import { useAgents } from '../hooks/use-agents';
import { useProjects } from '../hooks/use-projects';
import { useTeam } from '../hooks/use-teams';
import { useUiState, useUpdateUiState } from '../hooks/use-ui-state';
import { AgentStatusLabel } from './agent-status-label';
import { CreateProjectDialog } from './create-project-dialog';
import { SidebarNav, type SidebarNavSection } from './sidebar-nav';
import { ThemeSwitcher } from './ui/theme-switcher';

interface TeamSidebarProps {
	teamId: string;
}

export function TeamSidebar({ teamId }: TeamSidebarProps) {
	const params = { teamId };
	const navigate = useNavigate();
	const { data: agents } = useAgents(teamId);
	const { data: projects } = useProjects(teamId);
	const { data: team } = useTeam(teamId);
	const { data: uiState } = useUiState(teamId);
	const updateUiState = useUpdateUiState(teamId);
	const [createProjectOpen, setCreateProjectOpen] = useState(false);

	const activeAgents = (agents ?? [])
		.filter((a) => a.admin_status !== AgentAdminStatus.Disabled)
		.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

	const sortedProjects = [...(projects ?? [])].sort((a, b) => {
		if (a.slug === OPERATIONS_PROJECT_SLUG) return 1;
		if (b.slug === OPERATIONS_PROJECT_SLUG) return -1;
		return a.name.localeCompare(b.name);
	});

	const teamExpanded = uiState?.sidebar?.team_expanded ?? true;
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
				const isInternal = project.slug === OPERATIONS_PROJECT_SLUG;
				const issuesItem = {
					to: '/teams/$teamId/projects/$projectId/issues',
					params: projectParams,
					label: 'Issues',
					count: project.open_issue_count,
				};
				const containerItem = {
					to: '/teams/$teamId/projects/$projectId/container',
					params: projectParams,
					label: 'Container',
				};
				const subItems = isInternal
					? [issuesItem, containerItem]
					: [
							issuesItem,
							{
								to: '/teams/$teamId/projects/$projectId/documents',
								params: projectParams,
								label: 'Documents',
							},
							containerItem,
							{
								to: '/teams/$teamId/projects/$projectId/settings',
								params: projectParams,
								label: 'Settings',
							},
						];
				return {
					to: '/teams/$teamId/projects/$projectId',
					params: projectParams,
					label: isInternal ? <span className="italic">{project.name}</span> : project.name,
					subItems,
				};
			}),
		},
		{
			title: 'Team',
			titleTo: '/teams/$teamId/agents',
			titleParams: params,
			collapsible: true,
			collapsed: !teamExpanded,
			onToggle: () => {
				updateUiState.mutate({ sidebar: { team_expanded: !teamExpanded } });
			},
			onAdd: () => navigate({ to: '/teams/$teamId/agents/hire', params }),
			addLabel: 'Hire a new agent',
			items: [],
			children: activeAgents.map((agent) => ({
				to: '/teams/$teamId/agents/$agentId',
				params: { teamId, agentId: agent.slug },
				label: <AgentStatusLabel name={agent.title} runtimeStatus={agent.runtime_status} />,
			})),
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
			<div className="flex flex-col h-full">
				<div className="flex-1">
					<SidebarNav sections={sections} />
				</div>
				<div className="mt-2 pt-2 px-3 border-t border-border flex items-center justify-between gap-2">
					<Link
						to="/settings"
						className="inline-flex items-center gap-2 px-2 py-1 rounded-radius-md text-[13px] text-text-muted hover:text-text hover:bg-bg-subtle transition-colors"
						title="Settings"
					>
						<Settings className="w-4 h-4" />
						<span>Settings</span>
					</Link>
					<ThemeSwitcher />
				</div>
			</div>
			<CreateProjectDialog
				teamId={teamId}
				open={createProjectOpen}
				onOpenChange={setCreateProjectOpen}
			/>
		</>
	);
}
