import type { MarketplaceIndexEntry, MarketplaceTeamDef } from '@hezo/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';

/** The marketplace catalog (list-page metadata for every available team). */
export function useMarketplaceTeams() {
	return useQuery({
		queryKey: queryKeys.marketplaceTeams(),
		queryFn: () => api.get<MarketplaceIndexEntry[]>('/api/marketplace/teams'),
	});
}

/** A single marketplace team's full definition (roster + changelog + version). */
export function useMarketplaceTeam(slug: string) {
	return useQuery({
		queryKey: queryKeys.marketplaceTeam(slug),
		queryFn: () => api.get<MarketplaceTeamDef>(`/api/marketplace/teams/${slug}`),
		enabled: slug.length > 0,
	});
}

export interface AddMarketplaceTeamResponse {
	task_id: string;
	task_identifier: string;
}

/**
 * Adds a marketplace team's roster to an existing project. The server kicks off a
 * CEO task that hires the roster and reconciles it — the result lives on that task,
 * not this page, so callers surface a success toast linking to it.
 */
export function useAddMarketplaceTeam(projectId: string) {
	return useMutation({
		mutationFn: (slug: string) =>
			api.post<AddMarketplaceTeamResponse>(`/api/projects/${projectId}/marketplace-team`, { slug }),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.all(), exact: true });
		},
	});
}
