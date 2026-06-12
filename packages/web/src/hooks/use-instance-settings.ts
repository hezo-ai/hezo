import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';

export interface InstanceSettings {
	base_url: string | null;
}

export function useInstanceSettings() {
	return useQuery({
		queryKey: queryKeys.instanceSettings(),
		queryFn: () => api.get<InstanceSettings>('/api/instance-settings'),
	});
}

/**
 * Response-driven (not optimistic): the server validates and normalizes the
 * URL, so the cache is seeded from its echo rather than the typed value.
 */
export function useUpdateInstanceSettings() {
	return useMutation({
		mutationFn: (base_url: string | null) =>
			api.patch<InstanceSettings>('/api/instance-settings', { base_url }),
		onSuccess: (data) => {
			queryClient.setQueryData(queryKeys.instanceSettings(), data);
		},
	});
}
