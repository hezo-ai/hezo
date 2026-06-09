import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';
import { useOptimisticMutation } from './use-optimistic-mutation';

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

export function useSecrets(projectId: string) {
	return useQuery({
		queryKey: queryKeys.projects.secrets(projectId),
		queryFn: () => api.get<Secret[]>(`/api/projects/${projectId}/secrets`),
	});
}

export function useCreateSecret(projectId: string) {
	return useMutation({
		mutationFn: (data: CreateSecretPayload) =>
			api.post<Secret>(`/api/projects/${projectId}/secrets`, data),
		onSuccess: (created) => {
			queryClient.setQueryData<Secret[]>(queryKeys.projects.secrets(projectId), (prev) =>
				prev ? [...prev.filter((s) => s.id !== created.id), created] : [created],
			);
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.secrets(projectId) });
		},
	});
}

interface UpdateSecretVars {
	secretId: string;
	value?: string;
	category?: string;
	allowed_hosts?: string[];
	allow_all_hosts?: boolean;
}

export function useUpdateSecret(projectId: string) {
	return useOptimisticMutation<UpdateSecretVars, Secret, Secret[]>({
		mutationFn: ({ secretId, ...data }) =>
			api.patch<Secret>(`/api/projects/${projectId}/secrets/${secretId}`, data),
		queryKey: queryKeys.projects.secrets(projectId),
		applyOptimistic: (current, { secretId, value: _value, ...optimistic }) =>
			// `value` is write-only; it isn't returned in Secret rows.
			current?.map((s) => (s.id === secretId ? { ...s, ...optimistic } : s)),
		mergeResponse: (current, updated) =>
			current?.map((s) => (s.id === updated.id ? { ...s, ...updated } : s)),
		errorMessage: 'Failed to update secret',
	});
}

export function useDeleteSecret(projectId: string) {
	return useMutation({
		mutationFn: (secretId: string) => api.delete(`/api/projects/${projectId}/secrets/${secretId}`),
		onSuccess: (_, secretId) => {
			queryClient.setQueryData<Secret[]>(queryKeys.projects.secrets(projectId), (prev) =>
				prev ? prev.filter((s) => s.id !== secretId) : prev,
			);
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.secrets(projectId) });
		},
	});
}
