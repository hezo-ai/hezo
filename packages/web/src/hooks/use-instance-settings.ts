import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';

export interface InstanceSettings {
	base_url: string | null;
	max_chat_history_size: number;
	/** Effective active-container cap: the explicit setting, else the computed default. */
	max_container_memory_gb: number;
	/** True when the operator explicitly set a value (vs the automatic default). */
	max_container_memory_gb_is_set: boolean;
	/** The host-memory-computed default: (RAM + swap) / ram cap per container. */
	max_container_memory_gb_computed_default: number;
	default_ram_cap_per_container_gb: number;
	host_total_ram_bytes: number;
	host_total_swap_bytes: number;
}

export type InstanceSettingsUpdate = Partial<{
	base_url: string | null;
	max_chat_history_size: number;
	/** null resets to the automatic (host-memory-computed) default. */
	max_container_memory_gb: number | null;
	default_ram_cap_per_container_gb: number;
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
