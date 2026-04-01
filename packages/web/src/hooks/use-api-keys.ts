import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export interface ApiKey {
	id: string;
	company_id: string;
	name: string;
	prefix: string;
	key?: string;
	last_used_at: string | null;
	created_at: string;
}

export function useApiKeys(companyId: string) {
	return useQuery({
		queryKey: ['companies', companyId, 'api-keys'],
		queryFn: () => api.get<ApiKey[]>(`/api/companies/${companyId}/api-keys`),
	});
}

export function useCreateApiKey(companyId: string) {
	return useMutation({
		mutationFn: (data: { name: string }) =>
			api.post<ApiKey>(`/api/companies/${companyId}/api-keys`, data),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'api-keys'] }),
	});
}

export function useDeleteApiKey(companyId: string) {
	return useMutation({
		mutationFn: (apiKeyId: string) =>
			api.delete(`/api/companies/${companyId}/api-keys/${apiKeyId}`),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'api-keys'] }),
	});
}
