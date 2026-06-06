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

const listKey = (teamId: string) => ['teams', teamId, 'api-keys'] as const;

export function useApiKeys(teamId: string) {
	return useQuery({
		queryKey: listKey(teamId),
		queryFn: () => api.get<ApiKey[]>(`/api/teams/${teamId}/api-keys`),
	});
}

export function useCreateApiKey(teamId: string) {
	// Response-driven: the server mints the prefix + raw key. The list cache is
	// seeded from the response (minus the one-time raw `key`); the mutation's
	// returned data keeps `key` so the caller can show it once.
	return useResponseMutation<{ name: string }, ApiKey, ApiKey[]>({
		mutationFn: (data) => api.post<ApiKey>(`/api/teams/${teamId}/api-keys`, data),
		queryKey: listKey(teamId),
		merge: (prev, created) => {
			const { key: _key, ...row } = created;
			return prev ? [...prev.filter((k) => k.id !== row.id), row] : [row];
		},
		invalidateOnSettled: [listKey(teamId)],
	});
}

export function useDeleteApiKey(teamId: string) {
	return useInvalidatingMutation<string, unknown>({
		mutationFn: (apiKeyId) => api.delete(`/api/teams/${teamId}/api-keys/${apiKeyId}`),
		invalidate: [listKey(teamId)],
		onSuccess: (_data, apiKeyId) => {
			queryClient.setQueryData<ApiKey[]>(listKey(teamId), (prev) =>
				prev ? prev.filter((k) => k.id !== apiKeyId) : prev,
			);
		},
	});
}
