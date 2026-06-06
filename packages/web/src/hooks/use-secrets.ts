import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { useInvalidatingMutation } from './use-invalidating-mutation';
import { useOptimisticMutation } from './use-optimistic-mutation';
import { useResponseMutation } from './use-response-mutation';

const listKey = (teamId: string) => ['teams', teamId, 'secrets'] as const;

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
		queryKey: listKey(teamId),
		queryFn: () => api.get<Secret[]>(`/api/teams/${teamId}/secrets`),
	});
}

export function useCreateSecret(teamId: string) {
	// Response-driven: the secret value is write-only, so the row comes from the
	// server (never an optimistic guess) and seeds the list.
	return useResponseMutation<CreateSecretPayload, Secret, Secret[]>({
		mutationFn: (data) => api.post<Secret>(`/api/teams/${teamId}/secrets`, data),
		queryKey: listKey(teamId),
		merge: (prev, created) =>
			prev ? [...prev.filter((s) => s.id !== created.id), created] : [created],
		invalidateOnSettled: [listKey(teamId)],
	});
}

interface UpdateSecretVars {
	secretId: string;
	value?: string;
	category?: string;
	allowed_hosts?: string[];
	allow_all_hosts?: boolean;
}

export function useUpdateSecret(teamId: string) {
	return useOptimisticMutation<UpdateSecretVars, Secret, Secret[]>({
		mutationFn: ({ secretId, ...data }) =>
			api.patch<Secret>(`/api/teams/${teamId}/secrets/${secretId}`, data),
		queryKey: listKey(teamId),
		applyOptimistic: (current, { secretId, value: _value, ...optimistic }) =>
			// `value` is write-only; it isn't returned in Secret rows.
			current?.map((s) => (s.id === secretId ? { ...s, ...optimistic } : s)),
		mergeResponse: (current, updated) =>
			current?.map((s) => (s.id === updated.id ? { ...s, ...updated } : s)),
		errorMessage: 'Failed to update secret',
	});
}

export function useDeleteSecret(teamId: string) {
	return useInvalidatingMutation<string, unknown>({
		mutationFn: (secretId) => api.delete(`/api/teams/${teamId}/secrets/${secretId}`),
		invalidate: [listKey(teamId)],
		onSuccess: (_data, secretId) => {
			queryClient.setQueryData<Secret[]>(listKey(teamId), (prev) =>
				prev ? prev.filter((s) => s.id !== secretId) : prev,
			);
		},
	});
}
