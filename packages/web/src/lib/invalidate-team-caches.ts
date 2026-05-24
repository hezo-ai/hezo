import type { QueryClient } from '@tanstack/react-query';

/** Refresh rail avatars, org chart, and onboarding after agents are added or changed. */
export function invalidateTeamAgentCaches(queryClient: QueryClient, teamSlug: string): void {
	queryClient.invalidateQueries({ queryKey: ['teams', teamSlug, 'agents'] });
	queryClient.invalidateQueries({ queryKey: ['teams', teamSlug, 'org-chart'] });
	queryClient.invalidateQueries({ queryKey: ['teams', teamSlug, 'onboarding'] });
}

export function invalidateAllTeamAgentCaches(queryClient: QueryClient): void {
	queryClient.invalidateQueries({
		predicate: (query) => {
			const key = query.queryKey;
			return (
				Array.isArray(key) &&
				key[0] === 'teams' &&
				typeof key[1] === 'string' &&
				(key[2] === 'agents' || key[2] === 'org-chart' || key[2] === 'onboarding')
			);
		},
	});
}
