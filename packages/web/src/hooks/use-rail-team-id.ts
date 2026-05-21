import { useRouterState } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useTeams } from './use-teams';

const ACTIVE_TEAM_SLUG_KEY = 'hezo:activeTeamSlug';

function teamIdFromMatches(matches: { params: Record<string, string> }[]): string | undefined {
	for (let i = matches.length - 1; i >= 0; i--) {
		const id = matches[i]?.params.teamId;
		if (id) return id;
	}
	return undefined;
}

function readStoredTeamSlug(teams: { slug: string }[] | undefined): string | undefined {
	if (typeof window === 'undefined') return undefined;
	const stored = sessionStorage.getItem(ACTIVE_TEAM_SLUG_KEY);
	if (!stored) return undefined;
	return teams?.some((t) => t.slug === stored) ? stored : undefined;
}

/** Team slug for main-rail and home onboarding: route param, then last visited team, else first team. */
export function useRailTeamId(): string | undefined {
	const routeTeamId = useRouterState({
		select: (state) => teamIdFromMatches(state.matches),
	});
	const { data: teams } = useTeams();

	useEffect(() => {
		if (routeTeamId && typeof window !== 'undefined') {
			sessionStorage.setItem(ACTIVE_TEAM_SLUG_KEY, routeTeamId);
		}
	}, [routeTeamId]);

	return routeTeamId ?? readStoredTeamSlug(teams) ?? teams?.[0]?.slug;
}
