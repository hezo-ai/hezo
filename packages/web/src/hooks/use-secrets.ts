import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export interface Secret {
	id: string;
	team_id: string;
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

export function useSecrets(teamId: string) {
	return useQuery({
		queryKey: ['teams', teamId, 'secrets'],
		queryFn: () => api.get<Secret[]>(`/api/teams/${teamId}/secrets`),
	});
}

export function useCreateSecret(teamId: string) {
	return useMutation({
		mutationFn: (data: CreateSecretPayload) =>
			api.post<Secret>(`/api/teams/${teamId}/secrets`, data),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'secrets'] }),
	});
}

export function useUpdateSecret(teamId: string) {
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
		}) => api.patch<Secret>(`/api/teams/${teamId}/secrets/${secretId}`, data),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'secrets'] }),
	});
}

export function useDeleteSecret(teamId: string) {
	return useMutation({
		mutationFn: (secretId: string) => api.delete(`/api/teams/${teamId}/secrets/${secretId}`),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'secrets'] }),
	});
}
