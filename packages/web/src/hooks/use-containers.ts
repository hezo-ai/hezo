import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { ContainerState } from '../lib/container-display';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';

/**
 * One container, as the global Containers page shows it.
 *
 * Flat and pre-joined by the server: the page's whole job is to answer "what is
 * this, whose is it, and is anything using it", and three of those live in a
 * different table from the container itself.
 */
export interface ContainerSummary {
	container_id: string;
	project_id: string;
	project_slug: string;
	project_name: string;
	state: ContainerState;
	reserved_for_chat: boolean;
	has_unpushed_commits: boolean;
	disk_used_bytes: number;
	disk_ceiling_bytes: number;
	/**
	 * What this container was provisioned to hold, not what the project's cap says
	 * today. Null when the allocation was never recorded.
	 */
	memory_bytes: number | null;
	last_task_id: string | null;
	last_task_identifier: string | null;
	run_id: string | null;
	last_error: string | null;
	last_logs: string | null;
	last_started_at: string | null;
	last_released_at: string | null;
	created_at: string | null;
}

/**
 * How often the list refetches.
 *
 * Containers appear and go on their own - the pool provisions one whenever a run
 * needs it and reaps idle ones - so a static list is stale within seconds of
 * being opened, and this is the page an operator watches while something is
 * happening. There is no row-change broadcast for the pool table to key off, so
 * a poll is the honest mechanism rather than a fallback for a missing one.
 */
const CONTAINERS_POLL_MS = 5_000;

export function useContainers() {
	return useQuery<ContainerSummary[]>({
		queryKey: queryKeys.containers(),
		queryFn: () => api.get('/api/containers'),
		refetchInterval: CONTAINERS_POLL_MS,
	});
}

export function useContainer(containerId: string) {
	return useQuery<ContainerSummary>({
		queryKey: queryKeys.container(containerId),
		queryFn: () => api.get(`/api/containers/${containerId}`),
		refetchInterval: CONTAINERS_POLL_MS,
	});
}

/**
 * Remove one container.
 *
 * Invalidate-and-refetch rather than optimistic: the server stops the container,
 * removes it from the engine and fails the run it was serving, and the project
 * rows that change as a result are not something the client can predict. An
 * optimistic removal would also have to guess at the run's fate, which is the
 * one thing an operator is watching for.
 */
export function useRemoveContainer() {
	return useMutation({
		mutationFn: (containerId: string) => api.delete(`/api/containers/${containerId}`),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.containers() });
			// The project rows carry `container_id`/`container_status`, which this
			// may have just cleared.
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.all() });
		},
	});
}
