import { AgentAdminStatus } from '@hezo/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { AlertTriangle, ChevronsLeft, Globe, Info, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useActiveProject } from '../hooks/use-active-project';
import { useAgents } from '../hooks/use-agents';
import { useContainerHealth } from '../hooks/use-container-health';
import { useInboxUnreadCount } from '../hooks/use-inbox-count';
import { useProjectMeta } from '../hooks/use-projects';
import { useI18n } from '../lib/i18n';
import { agentPageParams } from './agent-link';
import { AgentStatusLabel } from './agent-status-label';
import { CreateTaskDialog } from './create-task-dialog';
import { SidebarNav, type SidebarNavSection } from './sidebar-nav';
import { Tooltip } from './ui/tooltip';

/**
 * The project menu: the persistent panel shown beside the project rail whenever
 * a project is active. Inbox leads as its own section; the project's pages
 * follow; the backing team's agents close it out under a Team section. The team
 * is presented as the project's own — there is no separate team-level view.
 */
export function ProjectSidebar({
	onCollapse,
	projectSlug,
}: {
	onCollapse?: () => void;
	projectSlug?: string;
} = {}) {
	const { t } = useI18n();
	const active = useActiveProject();
	const navigate = useNavigate();
	// The shell passes an explicit slug so the menu can fall back to HQ on a
	// non-project route (e.g. /home before the first project is created); on a
	// project route it passes the active slug, so the two agree.
	const projectId = projectSlug ?? active?.slug ?? '';
	const project = useProjectMeta(projectId);
	const health = useContainerHealth(project);
	const { data: inboxCount } = useInboxUnreadCount(projectId);
	const { data: agents } = useAgents(projectId);
	const [createTaskOpen, setCreateTaskOpen] = useState(false);
	// Goals are a project concept only (HQ has none). Use the open_goal_count carried on the
	// project index payload (the same source as open_task_count) rather than a separate per-page
	// goals fetch — the dot shows only once the project has loaded and reports zero active goals.
	const isInternalProject = project?.is_internal ?? false;
	const hasNoGoals = !isInternalProject && project != null && (project.open_goal_count ?? 0) === 0;

	if (!projectId) return null;

	const isInternal = project?.is_internal ?? false;
	const projectParams = { projectId };
	// `stopped` is the normal on-demand resting state — only genuine errors flag.
	const containerFailed = health?.kind === 'error';
	const containerProvisioning = health?.kind === 'provisioning' || health?.kind === 'rebuilding';

	const enabledAgents = (agents ?? []).filter((a) => a.admin_status !== AgentAdminStatus.Disabled);
	const byCreatedAt = (a: { created_at: string }, b: { created_at: string }) =>
		new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
	// Own roster leads; HQ agents (virtual members) trail with a global marker and
	// link to their canonical page in the HQ project.
	const ownAgents = enabledAgents.filter((a) => !a.is_instance).sort(byCreatedAt);
	const instanceAgents = enabledAgents.filter((a) => a.is_instance).sort(byCreatedAt);

	// Container and Activity: top-level on HQ (which has no Settings page to nest
	// under), but sub-items of Settings on a normal project — see below.
	const containerPage = {
		to: '/projects/$projectId/container',
		params: projectParams,
		testId: 'project-sidebar-container',
		label: (
			<span className="inline-flex items-center gap-1.5">
				<span>Container</span>
				{containerProvisioning && (
					<Loader2
						data-testid="project-sidebar-container-spinner"
						aria-hidden="true"
						className="w-3 h-3 shrink-0 animate-spin text-info"
					/>
				)}
				{containerFailed && (
					<Tooltip content="Container failed — click for details" side="right">
						<span
							role="img"
							data-testid="project-sidebar-container-error"
							aria-label="Container failed"
							className="inline-flex shrink-0 text-danger"
						>
							<AlertTriangle className="w-3 h-3" aria-hidden="true" />
						</span>
					</Tooltip>
				)}
			</span>
		),
	};
	const activityPage = {
		to: '/projects/$projectId/audit-log',
		params: projectParams,
		label: 'Activity',
		testId: 'project-sidebar-activity',
	};
	// Git (GitHub today; GitLab/others later) discloses under Settings on a
	// normal project, like Container and Activity. HQ has no Git page.
	const gitPage = {
		to: '/projects/$projectId/git',
		params: projectParams,
		label: 'Git',
		testId: 'project-sidebar-git',
	};
	// Connectors (this project's MCP servers + GitHub) also disclose under Settings.
	const connectorsPage = {
		to: '/projects/$projectId/connectors',
		params: projectParams,
		label: 'Connectors',
		testId: 'project-sidebar-connectors',
	};
	// Skills (this project's scoped skills + globals) disclose under Settings, below Connectors.
	const skillsPage = {
		to: '/projects/$projectId/skills',
		params: projectParams,
		label: 'Skills',
		testId: 'project-sidebar-skills',
	};
	// Custom Prompt — the project-wide instruction block injected into every agent's
	// prompt — discloses under Settings, alongside Skills.
	const customPromptPage = {
		to: '/projects/$projectId/custom-prompt',
		params: projectParams,
		label: 'Custom Prompt',
		testId: 'project-sidebar-custom-prompt',
	};

	// Progress (the Captain-maintained summary + recent task activity) leads under Inbox; it's a
	// normal-project concept, so HQ (internal) has none. Goals disclose beneath it — they are the
	// optional layer on top of progress, not the other way round.
	const goalsPage = {
		to: '/projects/$projectId/progress/goals',
		params: projectParams,
		label: t('nav.goals'),
		testId: 'project-sidebar-goals',
	};
	// The "no goals yet" nudge stays on the Progress row even though goals are what it is about:
	// sub-items only render once their parent's route is active, so on the Goals row the nudge
	// would only be visible to someone who had already navigated to it.
	const progressPage = {
		to: '/projects/$projectId/progress',
		params: projectParams,
		label: (
			<span className="inline-flex items-center gap-1.5">
				<span>{t('nav.progress')}</span>
				{hasNoGoals && (
					<Tooltip content="No goals yet — create one to focus the team" side="right">
						<span
							role="img"
							aria-label="No goals yet"
							data-testid="project-sidebar-goals-empty-dot"
							className="inline-block w-2 h-2 rounded-full bg-info animate-pulse shrink-0"
						/>
					</Tooltip>
				)}
			</span>
		),
		testId: 'project-sidebar-progress',
		subItems: [goalsPage],
	};

	const projectPages = [
		{
			to: '/projects/$projectId/tasks',
			params: projectParams,
			label: t('nav.tasks'),
			count: project?.open_task_count,
			testId: 'project-sidebar-tasks',
			action: {
				onClick: () => setCreateTaskOpen(true),
				label: 'New task',
				testId: 'project-sidebar-new-task',
			},
		},
		// HQ (internal) exposes Documents (the chatbox memory doc) and Assets (where
		// the CEO saves files it produces for the operator in chat); Budget and
		// Settings stay hidden below.
		{
			to: '/projects/$projectId/documents',
			params: projectParams,
			label: t('nav.documents'),
		},
		{
			to: '/projects/$projectId/assets',
			params: projectParams,
			label: t('nav.assets'),
		},
		...(isInternal
			? // HQ has no Settings — keep Container and Activity at the top level.
				[containerPage, activityPage]
			: [
					{
						to: '/projects/$projectId/budget',
						params: projectParams,
						label: t('nav.budget'),
						testId: 'project-sidebar-budget',
					},
					{
						to: '/projects/$projectId/settings',
						params: projectParams,
						label: t('nav.settings'),
						testId: 'project-sidebar-settings',
						// Git, Connectors, Skills, Container and Activity disclose under Settings
						// when it (or one of them) is the active route.
						subItems: [
							gitPage,
							connectorsPage,
							skillsPage,
							customPromptPage,
							containerPage,
							activityPage,
						],
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
				// Progress sits under Inbox; HQ (internal) has no goals.
				...(isInternal ? [] : [progressPage]),
			],
		},
		{ items: projectPages },
		{
			title: 'Team',
			titleTo: '/projects/$projectId/agents',
			titleParams: projectParams,
			onAdd: () => navigate({ to: '/projects/$projectId/agents/hire', params: projectParams }),
			addLabel: 'Hire a new agent',
			items: [
				...ownAgents.map((agent) => ({
					to: '/projects/$projectId/agents/$agentId',
					params: { projectId, agentId: agent.slug },
					label: (
						<AgentStatusLabel
							variant="sidebar"
							name={agent.title}
							runtimeStatus={agent.runtime_status}
						/>
					),
				})),
				...instanceAgents.map((agent) => ({
					to: '/projects/$projectId/agents/$agentId',
					params: agentPageParams(projectId, agent.slug, agent.is_instance),
					label: (
						<span className="flex flex-1 items-center gap-1.5 min-w-0">
							<Globe
								className="w-3 h-3 shrink-0 text-text-3"
								aria-label="Global agent — works across all projects"
							/>
							<AgentStatusLabel
								variant="sidebar"
								name={agent.title}
								runtimeStatus={agent.runtime_status}
							/>
						</span>
					),
				})),
			],
		},
	];

	return (
		<div className="flex flex-col h-full min-h-0">
			<div
				className={`relative pl-2.5 ${onCollapse ? 'pr-7' : 'pr-2.5'} pt-1.5 pb-1 flex items-center gap-1 min-w-0`}
			>
				<Link
					to="/projects/$projectId"
					params={projectParams}
					data-testid="project-sidebar-name"
					className="min-w-0 flex-1 text-[13px] font-semibold text-text-1 truncate"
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
				{isInternal && (
					<Tooltip
						content="Internal team coordination project, used for onboarding and team-level changes."
						side="right"
					>
						<button
							type="button"
							aria-label="About this project"
							data-testid="project-sidebar-info"
							className="shrink-0 text-text-3 hover:text-text-1 transition-colors"
						>
							<Info className="w-3.5 h-3.5" aria-hidden="true" />
						</button>
					</Tooltip>
				)}
				{onCollapse && (
					<Tooltip content="Collapse menu" side="bottom">
						<button
							type="button"
							aria-label="Collapse menu"
							data-testid="project-sidebar-collapse"
							onClick={onCollapse}
							className="absolute right-0.5 top-0.5 inline-flex h-6 w-6 items-center justify-center rounded-md text-text-3 transition-colors hover:bg-surface-2 hover:text-text-1"
						>
							<ChevronsLeft className="h-4 w-4" aria-hidden="true" />
						</button>
					</Tooltip>
				)}
			</div>
			<div className="flex-1 min-h-0 overflow-y-auto">
				<SidebarNav sections={sections} />
			</div>
			<CreateTaskDialog
				projectId={projectId}
				open={createTaskOpen}
				onOpenChange={setCreateTaskOpen}
			/>
		</div>
	);
}
