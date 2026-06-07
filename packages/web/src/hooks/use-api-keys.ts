import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { useInvalidatingMutation } from './use-invalidating-mutation';
import { useResponseMutation } from './use-response-mutation';

export interface ApiKey {
	id: string;
	team_id: string;
	name: string;
	prefix: string;
	key?: string;
	last_used_at: string | null;
	created_at: string;
}

const listKey = (projectId: string) => ['projects', projectId, 'api-keys'] as const;

export function useApiKeys(projectId: string) {
	return useQuery({
		queryKey: listKey(projectId),
		queryFn: () => api.get<ApiKey[]>(`/api/projects/${projectId}/api-keys`),
	});
}

export function useCreateApiKey(projectId: string) {
	// Response-driven: the server mints the prefix + raw key. The list cache is
	// seeded from the response (minus the one-time raw `key`); the mutation's
	// returned data keeps `key` so the caller can show it once.
	return useResponseMutation<{ name: string }, ApiKey, ApiKey[]>({
		mutationFn: (data) => api.post<ApiKey>(`/api/projects/${projectId}/api-keys`, data),
		queryKey: listKey(projectId),
		merge: (prev, created) => {
			const { key: _key, ...row } = created;
			return prev ? [...prev.filter((k) => k.id !== row.id), row] : [row];
		},
		invalidateOnSettled: [listKey(projectId)],
	});
}

export function useDeleteApiKey(projectId: string) {
	return useInvalidatingMutation<string, unknown>({
		mutationFn: (apiKeyId) => api.delete(`/api/projects/${projectId}/api-keys/${apiKeyId}`),
		invalidate: [listKey(projectId)],
		onSuccess: (_data, apiKeyId) => {
			queryClient.setQueryData<ApiKey[]>(listKey(projectId), (prev) =>
				prev ? prev.filter((k) => k.id !== apiKeyId) : prev,
			);
		},
	});
}
