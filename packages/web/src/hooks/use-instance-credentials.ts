import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

// Credentials are instance-global: one set of secrets shared with every team's
// egress. Only the Admin (superuser) manages them, via the un-prefixed
// /api/credentials + /api/secrets routes. Mutations are security-sensitive, so
// they invalidate + refetch — never optimistic.
export const INSTANCE_CREDENTIALS_KEY = ['instance', 'credentials'] as const;

// A secret row joined with its most-recent egress-proxy usage from the audit log.
export interface CredentialUsage {
	id: string;
	name: string;
	category: string;
	allowed_hosts: string[];
	allow_all_hosts: boolean;
	created_at: string;
	updated_at: string;
	last_used_at: string | null;
	use_count: number;
	last_host: string | null;
}

export interface InstanceSecret {
	id: string;
	name: string;
	category: string;
	allowed_hosts: string[];
	allow_all_hosts: boolean;
	created_at: string;
	updated_at: string;
}

export interface CreateInstanceSecretPayload {
	name: string;
	value: string;
	category?: string;
	allowed_hosts?: string[];
	allow_all_hosts?: boolean;
}

export interface UpdateInstanceSecretPayload {
	secretId: string;
	value?: string;
	category?: string;
	allowed_hosts?: string[];
	allow_all_hosts?: boolean;
}

export function useInstanceCredentials() {
	return useQuery({
		queryKey: INSTANCE_CREDENTIALS_KEY,
		queryFn: () => api.get<CredentialUsage[]>('/api/credentials'),
	});
}

export function useCreateInstanceSecret() {
	return useMutation({
		mutationFn: (data: CreateInstanceSecretPayload) =>
			api.post<InstanceSecret>('/api/secrets', data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: INSTANCE_CREDENTIALS_KEY });
		},
	});
}

export function useUpdateInstanceSecret() {
	return useMutation({
		mutationFn: ({ secretId, ...data }: UpdateInstanceSecretPayload) =>
			api.patch<InstanceSecret>(`/api/secrets/${secretId}`, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: INSTANCE_CREDENTIALS_KEY });
		},
	});
}

export function useDeleteInstanceSecret() {
	return useMutation({
		mutationFn: (secretId: string) => api.delete(`/api/secrets/${secretId}`),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: INSTANCE_CREDENTIALS_KEY });
		},
	});
}
