import { INTERNAL_PROJECT_SLUG } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { ChevronLeft, Settings } from 'lucide-react';
import { useInboxUnreadCount } from '../hooks/use-inbox-count';
import { useProjects } from '../hooks/use-projects';
import { useRouteProjectId } from '../hooks/use-route-project-id';
import { useRouteTeamId } from '../hooks/use-route-team-id';
import { useTeam } from '../hooks/use-teams';
import { SidebarNav, type SidebarNavSection } from './sidebar-nav';
import { ThemeSwitcher } from './ui/theme-switcher';

/**
 * Project-scoped sidebar: rendered (in place of TeamSidebar) when the route is
 * inside a specific project. The project's own pages are the primary nav; the
 * team it belongs to drops to a secondary "Team" section with its settings and
 * resources. Team-level routes keep the team-scoped TeamSidebar.
 */
export function ProjectSidebar() {
	const teamId = useRouteTeamId();
	const projectId = useRouteProjectId() ?? '';
	const { data: projects } = useProjects(teamId);
	const { data: team } = useTeam(teamId);
	const { data: inboxCount } = useInboxUnreadCount(teamId);

	const project = (projects ?? []).find((p) => p.slug === projectId);
	const isInternal = projectId === INTERNAL_PROJECT_SLUG;
	const projectParams = { teamId, projectId };
	const teamParams = { teamId };

	const projectItems = [
		{
			to: '/teams/$teamId/projects/$projectId/tasks',
			params: projectParams,
			label: 'Tasks',
			count: project?.open_task_count,
			testId: 'project-sidebar-tasks',
		},
		...(isInternal
			? []
			: [
					{
						to: '/teams/$teamId/projects/$projectId/documents',
						params: projectParams,
						label: 'Documents',
					},
					{
						to: '/teams/$teamId/projects/$projectId/assets',
						params: projectParams,
						label: 'Assets',
					},
				]),
		{
			to: '/teams/$teamId/projects/$projectId/container',
			params: projectParams,
			label: 'Container',
		},
		...(isInternal
			? []
			: [
					{
						to: '/teams/$teamId/projects/$projectId/settings',
						params: projectParams,
						label: 'Settings',
						testId: 'project-sidebar-settings',
					},
				]),
		{
			to: '/teams/$teamId/projects/$projectId/audit-log',
			params: projectParams,
			label: 'Activity',
		},
	];

	const sections: SidebarNavSection[] = [
		{ items: projectItems },
		{
			title: 'Team',
			titleTo: '/teams/$teamId/agents',
			titleParams: teamParams,
			items: [
				{
					to: '/teams/$teamId/inbox',
					params: teamParams,
					label: 'Inbox',
					count: inboxCount?.unread,
					testId: 'sidebar-link-inbox',
				},
				{
					to: '/teams/$teamId/tasks',
					params: teamParams,
					label: 'All Tasks',
					count: team?.open_task_count,
				},
				{ to: '/teams/$teamId/agents', params: teamParams, label: 'Agents' },
				{ to: '/teams/$teamId/projects', params: teamParams, label: 'All Projects' },
				{ to: '/teams/$teamId/skills', params: teamParams, label: 'Skills database' },
				{ to: '/teams/$teamId/connectors', params: teamParams, label: 'Connectors' },
				{ to: '/teams/$teamId/settings/general', params: teamParams, label: 'Settings' },
			],
		},
	];

	return (
		<div className="flex flex-col h-full">
			<div className="px-3 pt-2 pb-1">
				<Link
					to="/teams/$teamId/projects"
					params={teamParams}
					data-testid="project-sidebar-back"
					className="inline-flex items-center gap-1 text-[12px] text-text-subtle hover:text-text transition-colors"
				>
					<ChevronLeft className="w-3.5 h-3.5" /> All projects
				</Link>
				<Link
					to="/teams/$teamId/projects/$projectId"
					params={projectParams}
					data-testid="project-sidebar-name"
					className="block mt-1 text-[15px] font-medium text-text truncate"
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
			<div className="mt-2 pt-2 px-3 border-t border-border flex items-center justify-between gap-2">
				<Link
					to="/settings"
					className="inline-flex items-center gap-2 px-2 py-1 rounded-radius-md text-[13px] text-text-muted hover:text-text hover:bg-bg-subtle transition-colors"
				>
					<Settings className="w-4 h-4" />
					<span>Settings</span>
				</Link>
				<ThemeSwitcher />
			</div>
		</div>
	);
}
