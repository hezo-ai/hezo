import type { ApiKeyStatus } from '@hezo/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export const INSTANCE_API_KEYS_KEY = ['instance', 'api-keys'] as const;

export interface ApiKey {
	id: string;
	name: string;
	client_info: Record<string, unknown>;
	prefix: string;
	status: ApiKeyStatus;
	approved_at: string | null;
	last_used_at: string | null;
	created_at: string;
	/** Present only in the response that creates a key; shown once, never stored. */
	key?: string;
}

export function useApiKeys() {
	return useQuery({
		queryKey: INSTANCE_API_KEYS_KEY,
		queryFn: () => api.get<ApiKey[]>('/api/api-keys'),
	});
}

export function useCreateApiKey() {
	return useMutation({
		mutationFn: (data: { name: string }) => api.post<ApiKey>('/api/api-keys', data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: INSTANCE_API_KEYS_KEY });
		},
	});
}

export function useApproveApiKey() {
	return useMutation({
		mutationFn: (id: string) => api.post<ApiKey>(`/api/api-keys/${id}/approve`),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: INSTANCE_API_KEYS_KEY });
		},
	});
}

export function useDeleteApiKey() {
	return useMutation({
		mutationFn: (id: string) => api.delete(`/api/api-keys/${id}`),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: INSTANCE_API_KEYS_KEY });
		},
	});
}
