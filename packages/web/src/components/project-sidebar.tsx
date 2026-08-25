import { Link } from '@tanstack/react-router';
import { AlertTriangle, ChevronsLeft, Info } from 'lucide-react';
import { useState } from 'react';
import { useLaunchChat } from '../contexts/chat-launch-context';
import { useActiveProject } from '../hooks/use-active-project';
import { type ProjectChatRoomSummary, useProjectChatRooms } from '../hooks/use-chat';
import { useContainerHealth } from '../hooks/use-container-health';
import { useInboxUnreadCount } from '../hooks/use-inbox-count';
import { useProjectMeta } from '../hooks/use-projects';
import { useI18n } from '../lib/i18n';
import { CreateTaskDialog } from './create-task-dialog';
import { SidebarNav, type SidebarNavSection } from './sidebar-nav';
import { Tooltip } from './ui/tooltip';

/**
 * The project menu: the persistent panel shown beside the project rail whenever
 * a project is active. Dashboard leads, then Inbox; the project's pages
 * follow; the chat launcher cards close it out. The roster lives on the
 * Team & Budget page's Team tab - there is no separate team-level view.
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
	// The shell passes an explicit slug so the menu can fall back to HQ on a
	// non-project route (e.g. /home before the first project is created); on a
	// project route it passes the active slug, so the two agree.
	const projectId = projectSlug ?? active?.slug ?? '';
	const project = useProjectMeta(projectId);
	const health = useContainerHealth(project);
	const { data: inboxCount } = useInboxUnreadCount(projectId);
	// The project's DM launcher cards. HQ answers with an empty list (its chat
	// surface is the CEO stream behind the header monogram), so no gate needed.
	const { rooms: chatRooms } = useProjectChatRooms(projectId || null, true);
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
	// Provisioning no longer flags either: a project gets a container whenever a
	// run needs one, so a spinner here would be on more often than off and would
	// mark as noteworthy the most ordinary thing the system does.
	const containerFailed = health?.kind === 'error';

	// Container: top-level on HQ (which has no Settings page to nest under), but a
	// sub-item of Settings on a normal project — see below.
	const containerPage = {
		to: '/projects/$projectId/container',
		params: projectParams,
		testId: 'project-sidebar-container',
		label: (
			<span className="inline-flex items-center gap-1.5">
				<span>Containers</span>
				{containerFailed && (
					<Tooltip content="Container failed - click for details" side="right">
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
	// Git (GitHub today; GitLab/others later) discloses under Settings on a
	// normal project, like Container. HQ has no Git page.
	const gitPage = {
		to: '/projects/$projectId/git',
		params: projectParams,
		label: 'Git',
		testId: 'project-sidebar-git',
	};
	// Connectors (this project's MCP servers + GitHub) and Skills (its scoped skills +
	// globals) are top-level pages, not Settings sub-items: they're working surfaces the
	// team reaches constantly, not configuration set once. Both exist on HQ too — neither
	// route redirects internal projects away, unlike Git/Budget/Settings. They reuse the
	// `settings.*` catalog keys the global settings nav already carries, rather than
	// duplicating the same word into a `nav.*` key across all twelve catalogs.
	const connectorsPage = {
		to: '/projects/$projectId/connectors',
		params: projectParams,
		label: t('settings.connectors'),
		testId: 'project-sidebar-connectors',
	};
	const skillsPage = {
		to: '/projects/$projectId/skills',
		params: projectParams,
		label: t('settings.skills'),
		testId: 'project-sidebar-skills',
	};
	// Custom Prompt — the project-wide instruction block injected into every agent's
	// prompt — discloses under Settings, alongside Git.
	const customPromptPage = {
		to: '/projects/$projectId/custom-prompt',
		params: projectParams,
		label: 'Custom Prompt',
		testId: 'project-sidebar-custom-prompt',
	};

	// Goals sit top-level under Inbox: a normal-project concept, so HQ (internal) has none. The
	// project's progress narrative lives on the dashboard rather than a page of its own, so there
	// is no longer a Progress row for goals to nest under - which is also what lets the "no goals
	// yet" nudge ride the Goals row itself. Nested under Progress it could not, because a sub-item
	// only renders once its parent's route is active.
	const goalsPage = {
		to: '/projects/$projectId/goals',
		params: projectParams,
		label: (
			<span className="inline-flex items-center gap-1.5">
				<span>{t('nav.goals')}</span>
				{hasNoGoals && (
					<Tooltip content="No goals yet - create one to focus the team" side="right">
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
		testId: 'project-sidebar-goals',
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
		// Team & Budget replaces the old Budget entry and the Team link section:
		// the roster now lives on that page's Team tab. The link lands on Team.
		...(isInternal
			? // HQ has no Spend and no Settings, but it does hold the CEO/Coach
				// singletons and the assistant chat's container - which is metered like
				// any other. Container stays at the top level, after Connectors and
				// Skills.
				[
					{
						to: '/projects/$projectId/budget/team' as const,
						matchTo: '/projects/$projectId/budget',
						params: projectParams,
						label: t('nav.budget'),
						testId: 'project-sidebar-budget',
					},
					connectorsPage,
					skillsPage,
					containerPage,
				]
			: [
					{
						to: '/projects/$projectId/budget/team' as const,
						matchTo: '/projects/$projectId/budget',
						params: projectParams,
						label: t('nav.budget'),
						testId: 'project-sidebar-budget',
					},
					connectorsPage,
					skillsPage,
					{
						to: '/projects/$projectId/settings',
						params: projectParams,
						label: t('nav.settings'),
						testId: 'project-sidebar-settings',
						// Git, Custom Prompt and Container disclose under Settings when it
						// (or one of them) is the active route.
						subItems: [gitPage, customPromptPage, containerPage],
					},
				]),
	];

	// No Team section: the roster lives on the Team & Budget page's Team tab,
	// and the freed space below the links hosts the chat launcher cards.
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
				// Goals sit under Inbox; HQ (internal) has none.
				...(isInternal ? [] : [goalsPage]),
			],
		},
		{ items: projectPages },
	];

	return (
		<div className="flex flex-col h-full min-h-0">
			<div
				className={`relative pl-2.5 ${onCollapse ? 'pr-7' : 'pr-2.5'} pt-1.5 pb-1 flex items-center gap-1 min-w-0`}
			>
				<Link
					to="/projects/$projectId/dashboard"
					params={projectParams}
					data-testid="project-sidebar-dashboard"
					className="min-w-0 text-[13px] font-semibold text-text-1 truncate"
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
				{chatRooms.length > 0 && <ProjectChatCards projectId={projectId} rooms={chatRooms} />}
			</div>
			<CreateTaskDialog
				projectId={projectId}
				open={createTaskOpen}
				onOpenChange={setCreateTaskOpen}
			/>
		</div>
	);
}

/**
 * The project menu's chat launcher cards: one bordered card per roster agent,
 * unread first. An unread card grows a one-line preview and a stronger border;
 * clicking a card opens the dock on that agent's DM (no navigation - chat lives
 * in rooms, not routes).
 */
function ProjectChatCards({
	projectId,
	rooms,
}: {
	projectId: string;
	rooms: ProjectChatRoomSummary[];
}) {
	const { t } = useI18n();
	const launchChat = useLaunchChat();
	// Unread first, then server order (roster order, which is stable and matches
	// the Team section above).
	const sorted = [...rooms.filter((r) => r.unread), ...rooms.filter((r) => !r.unread)];
	return (
		<div className="px-2.5 pt-2.5 pb-1" data-testid="project-sidebar-chat">
			<div className="uppercase text-[11px] text-text-3 font-medium tracking-wide pb-1">
				{t('chat.section.title')}
			</div>
			<div className="flex flex-col gap-1.5">
				{sorted.map((room) => (
					<button
						key={room.member_id}
						type="button"
						data-testid={`chat-card-${room.slug}`}
						onClick={() =>
							launchChat({
								room: {
									kind: 'agent',
									projectSlug: projectId,
									agentSlug: room.slug,
									title: room.title,
								},
								draft: '',
							})
						}
						className={`w-full rounded-md border px-2 py-1.5 text-left transition-colors hover:bg-surface-2 ${
							room.unread ? 'border-border-strong' : 'border-border'
						}`}
					>
						<span className="flex min-w-0 items-center gap-1.5">
							<span className="truncate text-[12px] font-medium text-text-1">
								{room.display_name}
							</span>
							<span className="min-w-0 truncate text-[11px] text-text-3">{room.title}</span>
							{room.unread && (
								<span
									className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-info"
									data-testid={`chat-card-unread-${room.slug}`}
									aria-label={t('chat.card.unread')}
									role="img"
								/>
							)}
						</span>
						{room.unread && room.last_message_preview && (
							<span className="mt-0.5 block truncate text-[11px] text-text-2">
								{room.last_message_preview}
							</span>
						)}
					</button>
				))}
			</div>
		</div>
	);
}
