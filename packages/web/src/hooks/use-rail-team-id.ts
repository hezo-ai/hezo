import { useRouterState } from '@tanstack/react-router';
import { useTeams } from './use-teams';

function teamIdFromMatches(matches: { params: Record<string, string> }[]): string | undefined {
	for (let i = matches.length - 1; i >= 0; i--) {
		const id = matches[i]?.params.teamId;
		if (id) return id;
	}
	return undefined;
}

/** Team slug for main-rail member avatars: active route param, else first team (e.g. on /home). */
export function useRailTeamId(): string | undefined {
	const routeTeamId = useRouterState({
		select: (state) => teamIdFromMatches(state.matches),
	});
	const { data: teams } = useTeams();
	return routeTeamId ?? teams?.[0]?.slug;
}
