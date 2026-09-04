import { UpdateState } from '@hezo/shared';
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
	/**
	 * The instance comes back unlocked after the update restart - either the
	 * deliberate one-shot `--master-key` / `HEZO_MASTER_KEY` input supplies the key,
	 * or the supervisor holds the in-memory key and hands it to the relaunched worker.
	 */
	autoUnlock: boolean;
	/** The server can actually apply-and-restart (supervised compiled binary). */
	canApply: boolean;
	/**
	 * Agent runs in flight right now; the restart drains them. Optional because a
	 * server older than this field simply omits it, and the banner defaults to 0.
	 */
	runsInFlight?: number;
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

/** Poll cadence (ms) while a staged-update download is advancing. */
const POLL_INTERVAL_MS = 2500;

/**
 * Refetch cadence for the staged-update lifecycle while `useUpdateStatus({ poll })` is
 * active — the interval in ms, or `false` to stop.
 *
 * The server stages the download in the background (kicked by `GET /api/updates/status`
 * itself) and records only a coarse on-disk `state`, with no push when it changes, so the
 * UI has to poll to observe `idle → downloading → staged`. Keep polling while the server is
 * actively mid-flight (`checking`/`downloading`/`applying`) OR a self-applying instance has
 * an available update that hasn't reached a terminal state yet — the latter covers the
 * `idle` snapshot the first poll returns before the background stage has written
 * `downloading`, the gap that otherwise stranded the "Downloading new version…" spinner
 * until a manual reload. Terminal states (`staged`/`error`) stop the poll, and so does "no
 * update / can't self-apply in place" — there's nothing to wait for.
 */
export function updateStatusPollInterval(data: UpdateStatusInfo | undefined): number | false {
	if (!data) return false;
	const { state } = data;
	if (state === UpdateState.Staged || state === UpdateState.Error) return false;
	if (
		state === UpdateState.Checking ||
		state === UpdateState.Downloading ||
		state === UpdateState.Applying ||
		(data.updateAvailable && data.canApply)
	) {
		return POLL_INTERVAL_MS;
	}
	return false;
}

/**
 * Latest-release info plus the staged-update lifecycle and whether this instance
 * can apply-and-restart. Drives the "Install & restart" affordance.
 *
 * Pass `{ poll: true }` (the settings Version section and the top-of-shell banner) to
 * auto-refetch every few seconds while an update is downloading/staging, so the UI advances
 * through the lifecycle live without a manual reload. `updateStatusPollInterval` keeps
 * polling through the whole pre-terminal lifecycle — including the `idle` snapshot before
 * staging starts — and stops on its own once the state settles (`staged`/`error`) or there's
 * nothing to stage.
 */
export function useUpdateStatus(opts?: { poll?: boolean }) {
	return useQuery({
		queryKey: queryKeys.updateStatus(),
		queryFn: () => api.get<UpdateStatusInfo>('/api/updates/status'),
		staleTime: 60 * 60 * 1000,
		gcTime: 60 * 60 * 1000,
		retry: false,
		refetchInterval: opts?.poll ? (query) => updateStatusPollInterval(query.state.data) : undefined,
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
