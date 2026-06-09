import { useQueries, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/query-keys';
import { useAllVisibleProjects } from './use-projects';

export function useInboxUnreadCount(projectId: string, enabled = true) {
	return useQuery({
		queryKey: queryKeys.projects.inboxCount(projectId),
		queryFn: () => api.get<{ unread: number }>(`/api/projects/${projectId}/inbox/count`),
		enabled: enabled && !!projectId,
	});
}

/**
 * Total unread inbox items across every project the user can see — the count for
 * the global inbox. Shares per-project query keys with useInboxUnreadCount so
 * WebSocket-driven invalidations keep it live.
 */
export function useGlobalInboxUnreadCount(): number {
	const { projects } = useAllVisibleProjects();
	const queries = useQueries({
		queries: projects.map((p) => ({
			queryKey: queryKeys.projects.inboxCount(p.slug),
			queryFn: () => api.get<{ unread: number }>(`/api/projects/${p.slug}/inbox/count`),
			enabled: !!p.slug,
		})),
	});
	return queries.reduce((sum, q) => sum + (q.data?.unread ?? 0), 0);
}
