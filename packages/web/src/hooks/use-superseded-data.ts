import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';

export interface SupersededData {
	/** Number of `pgdata.superseded.*` snapshot directories. */
	count: number;
	/** Total on-disk size of those directories, in bytes. */
	bytes: number;
}

/**
 * Size of the embedded DB's retained pre-migration snapshots. Superuser +
 * embedded-only — pass `enabled: false` otherwise so the fetch is skipped
 * (external Postgres has none; other users would 403).
 */
export function useSupersededData(enabled: boolean) {
	return useQuery({
		queryKey: queryKeys.supersededData(),
		queryFn: () => api.get<SupersededData>('/api/database-info/superseded'),
		enabled,
	});
}

export interface PruneSupersededResult {
	removed: number;
	freed_bytes: number;
}

/**
 * Delete every `pgdata.superseded.*` snapshot. Destructive and irreversible, so
 * it invalidates + refetches rather than updating optimistically — the
 * refreshed size (the footer disappearing) is the confirmation. Mirrors the
 * security-sensitive credential mutations.
 */
export function usePruneSuperseded() {
	return useMutation({
		mutationFn: () => api.post<PruneSupersededResult>('/api/database-info/prune-superseded'),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.supersededData() });
			queryClient.invalidateQueries({ queryKey: queryKeys.databaseInfo() });
		},
	});
}
