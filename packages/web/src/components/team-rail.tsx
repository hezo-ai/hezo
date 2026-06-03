import { Link } from '@tanstack/react-router';
import { House, Inbox, Plus } from 'lucide-react';
import { useState } from 'react';
import { setActiveTeamSlug } from '../hooks/use-active-team-slug';
import { useMe } from '../hooks/use-me';
import { useRouteTeamId } from '../hooks/use-route-team-id';
import { useTeams } from '../hooks/use-teams';
import { CreateTeamDialog } from './create-team-dialog';
import { Avatar, avatarColorFromString } from './ui/avatar';

function initials(name: string): string {
	const words = name.split(/\s+/).filter(Boolean);
	if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
	return name.slice(0, 2).toUpperCase();
}

const iconLinkClass =
	'w-9 h-9 rounded-radius-md flex items-center justify-center text-text-muted hover:text-text hover:bg-bg-elevated transition-colors';

/**
 * The 60px team rail: a parallel navigation axis listing every team the user
 * belongs to, with quick links to the projects-primary home and the cross-team
 * inbox. The superuser sees a "+" to create a new team.
 */
export function TeamRail() {
	const { data: teams } = useTeams();
	const { data: me } = useMe();
	const activeTeamId = useRouteTeamId();
	const [createOpen, setCreateOpen] = useState(false);

	return (
		<>
			<nav
				className="w-[60px] shrink-0 h-full border-r border-border bg-bg-subtle flex flex-col items-center py-3 gap-2 overflow-y-auto"
				data-testid="team-rail"
				aria-label="Teams"
			>
				<Link
					to="/home"
					aria-label="Home"
					title="Home"
					data-testid="team-rail-home"
					className={iconLinkClass}
				>
					<House className="w-4 h-4" />
				</Link>
				<Link
					to="/home/inbox"
					aria-label="All inboxes"
					title="All inboxes"
					data-testid="team-rail-inbox"
					className={iconLinkClass}
				>
					<Inbox className="w-4 h-4" />
				</Link>
				<div className="w-7 border-t border-border my-1" />
				{(teams ?? []).map((team) => {
					const active = team.slug === activeTeamId;
					return (
						<Link
							key={team.id}
							to="/teams/$teamId/tasks"
							params={{ teamId: team.slug }}
							onClick={() => setActiveTeamSlug(team.slug)}
							title={team.name}
							aria-label={team.name}
							aria-current={active ? 'true' : undefined}
							data-testid={`team-rail-team-${team.slug}`}
							className={`rounded-radius-md ring-2 transition-all ${
								active ? 'ring-primary' : 'ring-transparent hover:ring-border-hover'
							}`}
						>
							<Avatar initials={initials(team.name)} color={avatarColorFromString(team.name)} />
						</Link>
					);
				})}
				{me?.is_superuser && (
					<button
						type="button"
						onClick={() => setCreateOpen(true)}
						title="New team"
						aria-label="New team"
						data-testid="team-rail-new"
						className="w-9 h-9 rounded-radius-md flex items-center justify-center text-text-muted hover:text-text hover:bg-bg-elevated border border-dashed border-border transition-colors"
					>
						<Plus className="w-4 h-4" />
					</button>
				)}
			</nav>
			<CreateTeamDialog open={createOpen} onOpenChange={setCreateOpen} />
		</>
	);
}
