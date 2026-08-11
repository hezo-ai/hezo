import type { ProjectDashboardNeedsYouItem } from '@hezo/shared';
import { useQueries, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/query-keys';
import { useAllVisibleProjects } from './use-projects';

export interface NeedsYouResponse {
	items: ProjectDashboardNeedsYouItem[];
	action_count: number;
}

export function useNeedsYou(projectId: string) {
	return useQuery({
		queryKey: queryKeys.projects.needsYou(projectId),
		queryFn: () => api.get<NeedsYouResponse>(`/api/projects/${projectId}/inbox/needs-you`),
		enabled: !!projectId,
	});
}

export function useInboxUnreadCount(projectId: string, enabled = true) {
	return useQuery({
		queryKey: queryKeys.projects.inboxCount(projectId),
		queryFn: () => api.get<{ unread: number }>(`/api/projects/${projectId}/inbox/count`),
		enabled: enabled && !!projectId,
	});
}

/**
 * Per-project unread inbox counts keyed by project slug, for every visible
 * project. Backs both the global inbox total and the per-avatar rail badges.
 * Shares per-project query keys with useInboxUnreadCount so WebSocket-driven
 * invalidations keep every consumer live.
 */
export function useInboxUnreadCountsBySlug(): Record<string, number> {
	const { projects } = useAllVisibleProjects();
	const queries = useQueries({
		queries: projects.map((p) => ({
			queryKey: queryKeys.projects.inboxCount(p.slug),
			queryFn: () => api.get<{ unread: number }>(`/api/projects/${p.slug}/inbox/count`),
			enabled: !!p.slug,
		})),
	});
	const bySlug: Record<string, number> = {};
	projects.forEach((p, i) => {
		bySlug[p.slug] = queries[i]?.data?.unread ?? 0;
	});
	return bySlug;
}

/**
 * Total unread inbox items across every project the user can see — the count for
 * the global inbox.
 */
export function useGlobalInboxUnreadCount(): number {
	return Object.values(useInboxUnreadCountsBySlug()).reduce((sum, n) => sum + n, 0);
}
