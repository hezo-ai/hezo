import { useQueries, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useTeams } from './use-teams';

export function useInboxUnreadCount(teamSlug: string, enabled = true) {
	return useQuery({
		queryKey: ['teams', teamSlug, 'inbox-count'],
		queryFn: () => api.get<{ unread: number }>(`/api/teams/${teamSlug}/inbox/count`),
		enabled: enabled && !!teamSlug,
	});
}

/**
 * Total unread inbox items across every team the user can see — the count for
 * the global inbox. Shares per-team query keys with useInboxUnreadCount so
 * WebSocket-driven invalidations keep it live.
 */
export function useGlobalInboxUnreadCount(): number {
	const { data: teams } = useTeams();
	const queries = useQueries({
		queries: (teams ?? []).map((team) => ({
			queryKey: ['teams', team.slug, 'inbox-count'],
			queryFn: () => api.get<{ unread: number }>(`/api/teams/${team.slug}/inbox/count`),
			enabled: !!team.slug,
		})),
	});
	return queries.reduce((sum, q) => sum + (q.data?.unread ?? 0), 0);
}
