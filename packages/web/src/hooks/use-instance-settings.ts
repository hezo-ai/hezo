import type { TaskView } from '@hezo/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';

export interface InstanceSettings {
	base_url: string | null;
	max_chat_history_size: number;
	/** Effective budget for ALL containers: the explicit setting, else the computed default. */
	max_container_memory_gb: number;
	/** True when the operator explicitly set a value (vs the automatic default). */
	max_container_memory_gb_is_set: boolean;
	/** The automatic default the server computed for this backend. */
	max_container_memory_gb_computed_default: number;
	/**
	 * The share of {@link max_container_memory_gb} task runs may hold; the rest is
	 * the assistant chat's reservation. Sent by the server rather than derived here
	 * so the page cannot drift from what admission actually uses.
	 */
	task_container_memory_gb: number;
	default_ram_cap_per_container_gb: number;
	/** Disk allocated to each container, in GB. Sibling of the RAM cap. */
	default_container_disk_gb: number;
	/**
	 * The memory containers are drawn from, or null when they do not run on the
	 * Hezo host - a managed sandbox backend, where the host's RAM had no part in
	 * the budget and rendering a formula from it would be a lie.
	 */
	host_total_ram_bytes: number | null;
	host_total_swap_bytes: number | null;
	/** Which view every task thread opens in on this instance. Admin-owned. */
	default_task_view: TaskView;
}

export type InstanceSettingsUpdate = Partial<{
	base_url: string | null;
	max_chat_history_size: number;
	/** null resets to the automatic (host-memory-computed) default. */
	max_container_memory_gb: number | null;
	default_ram_cap_per_container_gb: number;
	default_container_disk_gb: number;
	default_task_view: TaskView;
}>;

export function useInstanceSettings() {
	return useQuery({
		queryKey: queryKeys.instanceSettings(),
		queryFn: () => api.get<InstanceSettings>('/api/instance-settings'),
	});
}

/**
 * Response-driven (not optimistic): the server validates and normalizes values,
 * so the cache is seeded from its echo rather than the typed input. Accepts a
 * partial patch — only the supplied fields change.
 */
export function useUpdateInstanceSettings() {
	return useMutation({
		mutationFn: (update: InstanceSettingsUpdate) =>
			api.patch<InstanceSettings>('/api/instance-settings', update),
		onSuccess: (data) => {
			queryClient.setQueryData(queryKeys.instanceSettings(), data);
		},
	});
}
