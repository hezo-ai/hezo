import {
	AgentAdminStatus,
	AgentRuntimeStatus,
	CAPTAIN_AGENT_SLUG,
	COACH_AGENT_SLUG,
} from '@hezo/shared';
import { Link, useMatchRoute } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useAgents } from '../hooks/use-agents';
import { CaptainAvatar } from './captain-avatar';
import { CoachAvatar } from './coach-avatar';
import { Avatar, avatarColorFromString } from './ui/avatar';
import { Tooltip } from './ui/tooltip';

function agentInitials(title: string): string {
	const words = title.split(/\s+/).filter(Boolean);
	if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
	return title.slice(0, 2).toUpperCase();
}

interface TeamRailMembersProps {
	teamId: string;
}

export function TeamRailMembers({ teamId }: TeamRailMembersProps) {
	const matchRoute = useMatchRoute();
	const { data: agents } = useAgents(teamId);

	const members = (agents ?? [])
		.filter((a) => a.admin_status !== AgentAdminStatus.Disabled)
		.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

	if (members.length === 0) return null;

	return (
		<div
			className="flex flex-col items-center gap-1.5 w-full px-1.5"
			data-testid="team-rail-members"
		>
			{members.map((agent) => {
				const isActive = matchRoute({
					to: '/teams/$teamId/agents/$agentId',
					params: { teamId, agentId: agent.slug },
					fuzzy: true,
				});
				const tooltip = agent.title;
				const linkClass = `relative rounded-full transition-opacity hover:opacity-90 ${
					isActive ? 'ring-2 ring-primary ring-offset-2 ring-offset-bg-subtle' : ''
				}`;

				return (
					<Tooltip key={agent.id} content={tooltip} side="right">
						<Link
							to="/teams/$teamId/agents/$agentId"
							params={{ teamId, agentId: agent.slug }}
							className={linkClass}
							aria-label={agent.title}
							data-testid="team-rail-member"
						>
							{agent.slug === CAPTAIN_AGENT_SLUG ? (
								<CaptainAvatar size="md" />
							) : agent.slug === COACH_AGENT_SLUG ? (
								<CoachAvatar size="md" />
							) : (
								<Avatar
									initials={agentInitials(agent.title)}
									size="md"
									color={avatarColorFromString(agent.title)}
								/>
							)}
							{agent.runtime_status === AgentRuntimeStatus.Active && (
								<span
									className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-accent-green border-2 border-bg-subtle"
									aria-hidden
								/>
							)}
							{agent.runtime_status === AgentRuntimeStatus.Paused && (
								<span
									className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-accent-amber border-2 border-bg-subtle"
									aria-hidden
								/>
							)}
						</Link>
					</Tooltip>
				);
			})}
			<Tooltip content="Hire a new agent" side="right">
				<Link
					to="/teams/$teamId/agents/hire"
					params={{ teamId }}
					className="w-[36px] h-[36px] rounded-full flex items-center justify-center text-text-muted hover:text-text hover:bg-bg-muted transition-colors border border-dashed border-border"
					aria-label="Hire a new agent"
					data-testid="team-rail-hire"
				>
					<Plus className="w-4 h-4" />
				</Link>
			</Tooltip>
		</div>
	);
}
