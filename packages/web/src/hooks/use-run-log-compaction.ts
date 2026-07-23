import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';

/** An in-progress compaction pass (also the "in progress" flag). */
export interface RunLogCompactionState {
	started_at: string;
	older_than_days: number;
	/** Runs that matched the window when the pass started (progress-bar denominator). */
	total: number;
	processed: number;
	bytes_reclaimed: number;
}

/** The most recent completed compaction pass. */
export interface LastRunLogCompaction {
	finished_at: string;
	older_than_days: number;
	processed: number;
	bytes_reclaimed: number;
}

export interface RunLogUsage {
	backend: 'embedded' | 'external';
	/** On-disk database size — embedded only; null for external Postgres. */
	database_bytes: number | null;
	/** On-disk footprint of the run-logs table (main + TOAST + bloat), in bytes. */
	run_log_bytes: number;
	run_count: number;
	/** Disk a pass would reclaim (embedded: table bloat via VACUUM; external: 0). */
	reclaimable_bytes: number;
	/** Runs older than the window whose logs would be trimmed. */
	compactable_run_count: number;
	older_than_days: number;
	compaction: RunLogCompactionState | null;
	last: LastRunLogCompaction | null;
}

/** Poll cadence (ms) while a compaction pass is draining. */
const POLL_INTERVAL_MS = 2000;

/** Refetch every couple seconds while a pass is active, then stop. */
export function runLogUsagePollInterval(data: RunLogUsage | undefined): number | false {
	return data?.compaction != null ? POLL_INTERVAL_MS : false;
}

/**
 * Live database-usage figures and run-log compaction status for the given
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
 * Start a compaction pass over runs older than `olderThanDays`. The server kicks
 * the background drain and returns the active state; invalidating the usage
 * query (and the database-info prefix, so the size readout refreshes) starts the
 * poll that reflects progress. 409s if a pass is already running.
 */
export function useCompactRunLogs() {
	return useMutation({
		mutationFn: (olderThanDays: number) =>
			api.post<RunLogCompactionState>('/api/database-info/compact-run-logs', {
				older_than_days: olderThanDays,
			}),
		onSuccess: () => {
			// The databaseInfo prefix covers run-log-usage (all windows) + superseded.
			queryClient.invalidateQueries({ queryKey: queryKeys.databaseInfo() });
		},
	});
}
