import { AgentAdminStatus } from '@hezo/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { useActiveProject } from '../hooks/use-active-project';
import { useAgents } from '../hooks/use-agents';
import { useInboxUnreadCount } from '../hooks/use-inbox-count';
import { useProjectMeta } from '../hooks/use-projects';
import { AgentStatusLabel } from './agent-status-label';
import { SidebarNav, type SidebarNavSection } from './sidebar-nav';

/**
 * The project menu: the persistent panel shown beside the project rail whenever
 * a project is active. Inbox leads as its own section; the project's pages
 * follow; the backing team's agents close it out under a Team section. The team
 * is presented as the project's own — there is no separate team-level view.
 */
export function ProjectSidebar() {
	const active = useActiveProject();
	const navigate = useNavigate();
	const projectId = active?.slug ?? '';
	const project = useProjectMeta(projectId);
	const { data: inboxCount } = useInboxUnreadCount(projectId);
	const { data: agents } = useAgents(projectId);

	if (!active) return null;

	const isInternal = project?.is_internal ?? false;
	const projectParams = { projectId };

	const activeAgents = (agents ?? [])
		.filter((a) => a.admin_status !== AgentAdminStatus.Disabled)
		.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

	const projectPages = [
		{
			to: '/projects/$projectId/tasks',
			params: projectParams,
			label: 'Tasks',
			count: project?.open_task_count,
			testId: 'project-sidebar-tasks',
		},
		...(isInternal
			? []
			: [
					{
						to: '/projects/$projectId/documents',
						params: projectParams,
						label: 'Documents',
					},
					{
						to: '/projects/$projectId/assets',
						params: projectParams,
						label: 'Assets',
					},
				]),
		{
			to: '/projects/$projectId/container',
			params: projectParams,
			label: 'Container',
		},
		{
			to: '/projects/$projectId/audit-log',
			params: projectParams,
			label: 'Activity',
		},
		...(isInternal
			? []
			: [
					{
						to: '/projects/$projectId/settings',
						params: projectParams,
						label: 'Settings',
						testId: 'project-sidebar-settings',
					},
				]),
	];

	const sections: SidebarNavSection[] = [
		{
			items: [
				{
					to: '/projects/$projectId/inbox',
					params: projectParams,
					label: 'Inbox',
					count: inboxCount?.unread,
					testId: 'sidebar-link-inbox',
				},
			],
		},
		{ items: projectPages },
		{
			title: 'Team',
			titleTo: '/projects/$projectId/agents',
			titleParams: projectParams,
			onAdd: () => navigate({ to: '/projects/$projectId/agents/hire', params: projectParams }),
			addLabel: 'Hire a new agent',
			items: activeAgents.map((agent) => ({
				to: '/projects/$projectId/agents/$agentId',
				params: { projectId, agentId: agent.slug },
				label: <AgentStatusLabel name={agent.title} runtimeStatus={agent.runtime_status} />,
			})),
		},
	];

	return (
		<div className="flex flex-col h-full">
			<div className="px-2.5 pt-1.5 pb-1">
				<Link
					to="/projects/$projectId"
					params={projectParams}
					data-testid="project-sidebar-name"
					className="block text-[13px] font-semibold text-text truncate"
				>
					{project ? (
						isInternal ? (
							<span className="italic">{project.name}</span>
						) : (
							project.name
						)
					) : (
						projectId
					)}
				</Link>
			</div>
			<div className="flex-1">
				<SidebarNav sections={sections} />
			</div>
		</div>
	);
}
