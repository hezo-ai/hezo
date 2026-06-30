import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';

export interface InstanceSettings {
	base_url: string | null;
	max_chat_history_size: number;
}

export type InstanceSettingsUpdate = Partial<{
	base_url: string | null;
	max_chat_history_size: number;
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
