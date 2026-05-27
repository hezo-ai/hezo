import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export interface ApiKey {
	id: string;
	team_id: string;
	name: string;
	prefix: string;
	key?: string;
	last_used_at: string | null;
	created_at: string;
}

export function useApiKeys(teamId: string) {
	return useQuery({
		queryKey: ['teams', teamId, 'api-keys'],
		queryFn: () => api.get<ApiKey[]>(`/api/teams/${teamId}/api-keys`),
	});
}

export function useCreateApiKey(teamId: string) {
	return useMutation({
		mutationFn: (data: { name: string }) => api.post<ApiKey>(`/api/teams/${teamId}/api-keys`, data),
		onSuccess: (created) => {
			const { key: _key, ...row } = created;
			queryClient.setQueryData<ApiKey[]>(['teams', teamId, 'api-keys'], (prev) =>
				prev ? [...prev.filter((k) => k.id !== row.id), row as ApiKey] : [row as ApiKey],
			);
			queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'api-keys'] });
		},
	});
}

export function useDeleteApiKey(teamId: string) {
	return useMutation({
		mutationFn: (apiKeyId: string) => api.delete(`/api/teams/${teamId}/api-keys/${apiKeyId}`),
		onSuccess: (_, apiKeyId) => {
			queryClient.setQueryData<ApiKey[]>(['teams', teamId, 'api-keys'], (prev) =>
				prev ? prev.filter((k) => k.id !== apiKeyId) : prev,
			);
			queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'api-keys'] });
		},
	});
}
