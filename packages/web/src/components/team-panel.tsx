import { AgentAdminStatus, CEO_AGENT_SLUG } from '@hezo/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { Globe, MessageSquare, Plus, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { useLaunchChat } from '../contexts/chat-launch-context';
import { type Agent, useAgents } from '../hooks/use-agents';
import { CEO_ROOM } from '../hooks/use-chat';
import { useOrgChart } from '../hooks/use-org-chart';
import { useProjectMeta } from '../hooks/use-projects';
import { useTeam } from '../hooks/use-teams';
import { useI18n } from '../lib/i18n';
import { agentDisplayName } from './agent-identity-tooltip';
import { agentPageParams } from './agent-link';
import { AgentStatusLabel } from './agent-status-label';
import { ExportTeamButton } from './export-team-dialog';
import { HireAgentChooserDialog } from './hire-agent-chooser-dialog';
import { OrgChartTree } from './org-chart-tree';
import { Button } from './ui/button';
import { EmptyState } from './ui/empty-state';
import { ExpandableText } from './ui/expandable-text';
import { StatusDot } from './ui/status-dot';
import { Tooltip } from './ui/tooltip';

/**
 * One member card in the wrapping roster grid: the whole card links to the
 * agent's page; the chat shortcut opens the dock on that agent's DM instead
 * (the CEO's opens the pinned CEO stream; the Coach reviews rather than chats,
 * so its card carries no shortcut).
 */
function MemberCard({ projectId, agent }: { projectId: string; agent: Agent }) {
	const { t } = useI18n();
	const launchChat = useLaunchChat();
	const isCeo = agent.is_instance && agent.slug === CEO_AGENT_SLUG;
	const chatRoom = isCeo
		? CEO_ROOM
		: agent.is_instance
			? null
			: ({
					kind: 'agent',
					projectSlug: projectId,
					agentSlug: agent.slug,
					title: agent.title,
				} as const);

	return (
		<Link
			to="/projects/$projectId/agents/$agentId"
			params={agentPageParams(projectId, agent.slug, agent.is_instance)}
			data-testid={`member-card-${agent.slug}`}
			className="group flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2.5 transition-colors hover:border-border-strong"
		>
			<span className="min-w-0 flex-1">
				<span className="flex items-center gap-1.5 text-[13px] text-text-1">
					{agent.is_instance && (
						<Globe
							className="h-3 w-3 shrink-0 text-text-3"
							aria-label={t('agents.card.globalAgent')}
						/>
					)}
					<AgentStatusLabel
						variant="sidebar"
						name={agentDisplayName(agent)}
						agent={agent}
						runtimeStatus={agent.runtime_status}
					/>
				</span>
				{/* The role subline only earns its row when a name sits above it -
				    an unnamed agent's display name IS the role. */}
				{agentDisplayName(agent) !== agent.title && (
					<span className="mt-0.5 block truncate text-[11.5px] text-text-3">{agent.title}</span>
				)}
			</span>
			{chatRoom && (
				<Tooltip content={t('chat.launcher.label')} side="top">
					<button
						type="button"
						aria-label={
							isCeo ? t('chat.launcher.label') : t('agents.card.chatWith', { name: agent.title })
						}
						data-testid={`member-card-chat-${agent.slug}`}
						onClick={(e) => {
							e.preventDefault();
							e.stopPropagation();
							launchChat({ room: chatRoom, draft: '' });
						}}
						className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border text-text-3 transition-colors hover:border-border-strong hover:bg-surface-2 hover:text-text-1"
					>
						<MessageSquare className="h-3.5 w-3.5" aria-hidden />
					</button>
				</Tooltip>
			)}
		</Link>
	);
}

/**
 * The Team tab of the Team & Budget page: the hire/export actions, the
 * generated team summary, the org chart, and the wrapping member-card grid
 * (own roster first, then the global CEO/Coach, then the dashed hire card).
 *
 * `hireOpen`/`onHireOpenChange` are lifted to the route so the hire form's
 * back link (`?hire`) can reopen the chooser on arrival.
 */
export function TeamPanel({
	projectId,
	hireOpen,
	onHireOpenChange,
}: {
	projectId: string;
	hireOpen: boolean;
	onHireOpenChange: (open: boolean) => void;
}) {
	const { t } = useI18n();
	const { data: orgChart, isLoading } = useOrgChart(projectId);
	const { data: team } = useTeam(projectId);
	const { data: agents } = useAgents(projectId);
	const project = useProjectMeta(projectId);

	if (isLoading)
		return <div className="text-text-2 text-[13px] py-8 text-center">{t('common.loading')}</div>;

	const roots = orgChart?.admin.children ?? [];
	const hasMembers = roots.length > 0;
	// HQ hosts the two instance singletons (CEO, Coach) and nothing else - it is
	// not a team you staff, and marketplace roles are written for project teams.
	const canHire = !(project?.is_internal ?? false);
	const enabled = (agents ?? []).filter((a) => a.admin_status !== AgentAdminStatus.Disabled);
	const byCreatedAt = (a: { created_at: string }, b: { created_at: string }) =>
		new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
	const roster = [
		...enabled.filter((a) => !a.is_instance).sort(byCreatedAt),
		...enabled.filter((a) => a.is_instance).sort(byCreatedAt),
	];

	return (
		<div className="min-w-0">
			<div className="flex items-center justify-end gap-2 mb-4">
				{canHire && (
					<Button onClick={() => onHireOpenChange(true)} data-testid="hire-agent">
						<UserPlus className="w-4 h-4" /> {t('agents.hire.action')}
					</Button>
				)}
				<ExportTeamButton projectId={projectId} />
			</div>

			{canHire && (
				<HireAgentChooserDialog
					projectId={projectId}
					open={hireOpen}
					onOpenChange={onHireOpenChange}
				/>
			)}

			<div
				data-testid="team-summary"
				className="rounded-lg border border-border-subtle bg-surface-2 p-4 text-sm leading-relaxed text-text-1 mb-1"
			>
				<ExpandableText
					text={team?.summary ?? ''}
					projectId={projectId}
					placeholder={
						<span className="italic text-text-2">Team description being generated…</span>
					}
				/>
			</div>
			<p data-testid="team-summary-attribution" className="text-xs text-text-2 italic mb-6">
				Auto-generated from the agents' system prompts.
			</p>

			{!hasMembers ? (
				<EmptyState icon={<Plus className="w-10 h-10" />} title="No team members yet" />
			) : (
				<>
					<div className="pt-4">
						<OrgChartTree
							roots={roots}
							projectId={projectId}
							mode="interactive"
							testId="team-org-chart"
						/>
					</div>

					<div className="flex items-center gap-4 mt-8 pt-4 border-t border-border text-xs text-text-2">
						<div className="flex items-center gap-1.5">
							<StatusDot status="active" /> Active
						</div>
						<div className="flex items-center gap-1.5">
							<StatusDot status="paused" /> Over budget
						</div>
						<div className="flex items-center gap-1.5">
							<StatusDot status="disabled" /> Disabled
						</div>
					</div>
				</>
			)}

			{/* The wrapping member-card grid: every member as a card (the global
			    CEO/Coach included, marked by the globe), each with a chat shortcut,
			    plus the dashed hire card on staffable teams. */}
			{roster.length > 0 && (
				<div
					data-testid="team-member-grid"
					className="mt-6 grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3"
				>
					{roster.map((agent) => (
						<MemberCard key={agent.id} projectId={projectId} agent={agent} />
					))}
					{canHire && (
						<button
							type="button"
							onClick={() => onHireOpenChange(true)}
							data-testid="team-hire-card"
							className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-border px-3 py-2.5 text-[13px] text-text-3 transition-colors hover:border-border-strong hover:text-text-1"
						>
							<UserPlus className="h-4 w-4" aria-hidden /> {t('agents.hire.action')}
						</button>
					)}
				</div>
			)}
		</div>
	);
}

/**
 * Search-param plumbing shared by the Team tab: `?hire` opens the chooser on
 * arrival (the hire form's back link), and dismissing clears the param so the
 * next visit is not met by the dialog again.
 */
export function useHireChooserVisibility(projectId: string, hire: boolean | undefined) {
	const navigate = useNavigate();
	const [open, setOpen] = useState(false);
	const visible = open || hire === true;
	const setVisible = (next: boolean) => {
		setOpen(next);
		if (!next && hire) {
			navigate({ to: '/projects/$projectId/budget/team', params: { projectId }, replace: true });
		}
	};
	return [visible, setVisible] as const;
}
