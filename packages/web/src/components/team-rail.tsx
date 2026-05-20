import { Link } from '@tanstack/react-router';
import { Home, Inbox, Settings } from 'lucide-react';
import { useMemo } from 'react';
import { useAllPendingApprovals } from '../hooks/use-approvals';
import { useRailTeamId } from '../hooks/use-rail-team-id';
import { useTeams } from '../hooks/use-teams';
import { TeamRailMembers } from './team-rail-members';
import { ThemeSwitcher } from './ui/theme-switcher';

export function TeamRail() {
	const { data: teams } = useTeams();
	const railTeamId = useRailTeamId();
	const teamSlugs = useMemo(() => (teams ?? []).map((c) => c.slug).sort(), [teams]);
	const approvalsQuery = useAllPendingApprovals(teamSlugs);
	const pendingCount = approvalsQuery.data?.length ?? 0;

	return (
		<aside className="w-[60px] shrink-0 border-r border-border bg-bg-subtle flex flex-col items-center py-3 gap-2 overflow-y-auto">
			<Link
				to="/home"
				className="w-[36px] h-[36px] rounded-full flex items-center justify-center text-text-muted hover:text-text hover:bg-bg-muted transition-colors"
				title="Home"
			>
				<Home className="w-4 h-4" />
			</Link>

			<Link
				to="/inbox"
				className="relative w-[36px] h-[36px] rounded-full flex items-center justify-center text-text-muted hover:text-text hover:bg-bg-muted transition-colors"
				title="Inbox"
				data-testid="team-rail-inbox"
			>
				<Inbox className="w-4 h-4" />
				{pendingCount > 0 && (
					<span className="absolute -top-1 -right-1 flex items-center justify-center w-4 h-4 rounded-full bg-accent-red text-white text-[10px] font-bold">
						{pendingCount}
					</span>
				)}
			</Link>

			{railTeamId ? <TeamRailMembers teamId={railTeamId} /> : null}

			<div className="mt-auto flex flex-col items-center gap-1 pt-2">
				<ThemeSwitcher />
				<Link
					to="/settings"
					className="inline-flex items-center justify-center w-8 h-8 rounded-radius-md text-text-muted hover:text-text hover:bg-bg-muted transition-colors"
					title="Settings"
				>
					<Settings className="w-4 h-4" />
				</Link>
			</div>
		</aside>
	);
}
