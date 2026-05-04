import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export interface Secret {
	id: string;
	company_id: string;
	project_id: string | null;
	name: string;
	category: string;
	allowed_hosts: string[];
	allow_all_hosts: boolean;
	created_at: string;
	updated_at: string;
	project_name: string | null;
	grant_count: number;
}

export interface CreateSecretPayload {
	name: string;
	value: string;
	project_id?: string;
	category?: string;
	allowed_hosts?: string[];
	allow_all_hosts?: boolean;
}

export function useSecrets(companyId: string) {
	return useQuery({
		queryKey: ['companies', companyId, 'secrets'],
		queryFn: () => api.get<Secret[]>(`/api/companies/${companyId}/secrets`),
	});
}

export function useCreateSecret(companyId: string) {
	return useMutation({
		mutationFn: (data: CreateSecretPayload) =>
			api.post<Secret>(`/api/companies/${companyId}/secrets`, data),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'secrets'] }),
	});
}

export function useUpdateSecret(companyId: string) {
	return useMutation({
		mutationFn: ({
			secretId,
			...data
		}: {
			secretId: string;
			value?: string;
			category?: string;
			allowed_hosts?: string[];
			allow_all_hosts?: boolean;
		}) => api.patch<Secret>(`/api/companies/${companyId}/secrets/${secretId}`, data),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'secrets'] }),
	});
}

export function useDeleteSecret(companyId: string) {
	return useMutation({
		mutationFn: (secretId: string) => api.delete(`/api/companies/${companyId}/secrets/${secretId}`),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'secrets'] }),
	});
}
