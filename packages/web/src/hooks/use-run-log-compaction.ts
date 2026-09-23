import type { ActiveRunLogPass, RunLogUsage } from '@hezo/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';

export type { ActiveRunLogPass, FinishedRunLogPass, RunLogUsage } from '@hezo/shared';

/** Poll cadence (ms) while a pass is running. */
const POLL_INTERVAL_MS = 2000;

/** Refetch every couple seconds while a pass is active, then stop. */
export function runLogUsagePollInterval(data: RunLogUsage | undefined): number | false {
	return data?.compaction != null ? POLL_INTERVAL_MS : false;
}

/**
 * Live database-usage figures and run-log maintenance status for the given
 * retention window. Superuser-only — pass `enabled: false` otherwise so the
 * fetch is skipped (other users would 403). Polls itself while a pass runs so
 * the progress + disabled state advance without a manual reload.
 */
export function useRunLogUsage(olderThanDays: number, enabled: boolean) {
	return useQuery({
		queryKey: queryKeys.runLogUsage(olderThanDays),
		queryFn: () =>
			api.get<RunLogUsage>(`/api/database-info/run-log-usage?older_than_days=${olderThanDays}`),
		enabled,
		refetchInterval: (query) => runLogUsagePollInterval(query.state.data),
	});
}

/**
 * The database-info prefix covers run-log-usage (all windows) + superseded, so
 * invalidating it refreshes the size readout and starts the progress poll.
 */
function refreshDatabaseInfo(): void {
	queryClient.invalidateQueries({ queryKey: queryKeys.databaseInfo() });
}

/**
 * Start a compaction pass over runs older than `olderThanDays`. The server kicks
 * the background drain and returns the active pass. 409s if a pass is already
 * running.
 */
export function useCompactRunLogs() {
	return useMutation({
		mutationFn: (olderThanDays: number) =>
			api.post<ActiveRunLogPass>('/api/database-info/compact-run-logs', {
				older_than_days: olderThanDays,
			}),
		onSuccess: refreshDatabaseInfo,
	});
}

/**
 * Start a pass that rewrites the run-log tables to return their free space to
 * the disk. Long-running work, so it invalidates and polls rather than updating
 * optimistically. 409s if a pass is already running.
 */
export function useReclaimRunLogSpace() {
	return useMutation({
		mutationFn: () => api.post<ActiveRunLogPass>('/api/database-info/reclaim-run-log-space'),
		onSuccess: refreshDatabaseInfo,
	});
}
