import type { QueryClient } from '@tanstack/react-query';

/** Refresh rail avatars and org chart after agents are added or changed. */
export function invalidateTeamAgentCaches(queryClient: QueryClient, projectSlug: string): void {
	queryClient.invalidateQueries({ queryKey: ['projects', projectSlug, 'agents'] });
	queryClient.invalidateQueries({ queryKey: ['projects', projectSlug, 'org-chart'] });
}

export function invalidateAllTeamAgentCaches(queryClient: QueryClient): void {
	queryClient.invalidateQueries({
		predicate: (query) => {
			const key = query.queryKey;
			return (
				Array.isArray(key) &&
				key[0] === 'projects' &&
				typeof key[1] === 'string' &&
				(key[2] === 'agents' || key[2] === 'org-chart')
			);
		},
	});
}
