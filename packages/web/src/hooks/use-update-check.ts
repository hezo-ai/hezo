import type { UpdateState } from '@hezo/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

export interface UpdateInfo {
	current: string;
	latest: string | null;
	updateAvailable: boolean;
	url: string | null;
}

export interface UpdateStatusInfo extends UpdateInfo {
	/** Lifecycle of any staged update on the server. */
	state: UpdateState;
	targetVersion: string | null;
	error: string | null;
	/** A master key is configured, so the instance auto-unlocks after a restart. */
	autoUnlock: boolean;
	/** The server can actually apply-and-restart (supervised compiled binary). */
	canApply: boolean;
}

/**
 * Poll the server's GitHub-Releases check. The server caches upstream for an
 * hour and fails soft, so this is cheap and never errors the shell.
 */
export function useUpdateCheck() {
	return useQuery({
		queryKey: queryKeys.updateCheck(),
		queryFn: () => api.get<UpdateInfo>('/api/updates/latest'),
		staleTime: 60 * 60 * 1000,
		gcTime: 60 * 60 * 1000,
		retry: false,
	});
}

/**
 * Force a fresh GitHub release check now (bypassing the server's 1h cache) — the
 * same upstream check the daily cron runs. Drives the settings "Check for new
 * version" button; seeds the `updateCheck` query with the result so the version
 * display reflects it immediately.
 */
export function useCheckForUpdate() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () => api.post<UpdateInfo>('/api/updates/check'),
		onSuccess: (data) => {
			queryClient.setQueryData(queryKeys.updateCheck(), data);
			queryClient.invalidateQueries({ queryKey: queryKeys.updateStatus() });
		},
	});
}

/**
 * Latest-release info plus the staged-update lifecycle and whether this instance
 * can apply-and-restart. Drives the "Install & restart" affordance.
 */
export function useUpdateStatus() {
	return useQuery({
		queryKey: queryKeys.updateStatus(),
		queryFn: () => api.get<UpdateStatusInfo>('/api/updates/status'),
		staleTime: 60 * 60 * 1000,
		gcTime: 60 * 60 * 1000,
		retry: false,
	});
}

/**
 * Apply the staged update: the server shuts down and exits with the restart
 * sentinel, the supervisor swaps the binary and relaunches. The response lands
 * before the process exits; the caller then shows the restart overlay.
 */
export function useApplyUpdate() {
	return useMutation({
		mutationFn: () =>
			api.post<{ state: UpdateState; targetVersion: string | null }>('/api/updates/apply'),
	});
}

/**
 * Kick a fresh background download+verify+stage of the latest release. Used by the
 * banner to retry after a failed/abandoned auto-stage, since the server's poll-driven
 * staging backs off on error. Invalidates the status query so the lifecycle
 * (`downloading → staged`) is reflected as the server progresses.
 */
export function useDownloadUpdate() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () =>
			api.post<{ data: { state: UpdateState; targetVersion: string | null } }>(
				'/api/updates/download',
			),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.updateStatus() }),
	});
}
