import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { api, nextOffsetPageParam } from '../lib/api';
import { queryClient } from '../lib/query-client';

// Credentials are instance-global: one set of secrets shared with every team's
// egress. Only the Admin (superuser) manages them, via the un-prefixed
// /api/credentials + /api/secrets routes. Mutations are security-sensitive, so
// they invalidate + refetch — never optimistic.
export const INSTANCE_CREDENTIALS_KEY = ['instance', 'credentials'] as const;
// Infinite-scroll key under the base key so mutation invalidations cascade.
export const INSTANCE_CREDENTIALS_INFINITE_KEY = ['instance', 'credentials', 'infinite'] as const;

// A connector that references a credential (its pasted API key, or the access
// token of its OAuth connection). `project_id`/`project_slug` are null for a
// global ("all projects") connector.
export interface CredentialConnectorRef {
	id: string;
	name: string;
	display_name: string | null;
	project_id: string | null;
	project_slug: string | null;
}

// A secret row joined with its most-recent egress-proxy usage from the audit log
// and the connectors that use it.
export interface CredentialUsage {
	id: string;
	name: string;
	category: string;
	allowed_hosts: string[];
	allow_all_hosts: boolean;
	allow_body_substitution: boolean;
	created_at: string;
	updated_at: string;
	last_used_at: string | null;
	use_count: number;
	last_host: string | null;
	connectors: CredentialConnectorRef[];
}

export interface InstanceSecret {
	id: string;
	name: string;
	category: string;
	allowed_hosts: string[];
	allow_all_hosts: boolean;
	allow_body_substitution: boolean;
	created_at: string;
	updated_at: string;
}

export interface CreateInstanceSecretPayload {
	name: string;
	value: string;
	category?: string;
	allowed_hosts?: string[];
	allow_all_hosts?: boolean;
	allow_body_substitution?: boolean;
}

export interface UpdateInstanceSecretPayload {
	secretId: string;
	value?: string;
	category?: string;
	allowed_hosts?: string[];
	allow_all_hosts?: boolean;
	allow_body_substitution?: boolean;
}

export function useInstanceCredentials(options?: { perPage?: number }) {
	const perPage = options?.perPage ?? 50;
	return useInfiniteQuery({
		queryKey: [...INSTANCE_CREDENTIALS_INFINITE_KEY, { per_page: String(perPage) }],
		initialPageParam: 1,
		queryFn: ({ pageParam }) =>
			api.getPaginated<CredentialUsage>('/api/credentials', {
				page: String(pageParam),
				per_page: String(perPage),
			}),
		getNextPageParam: nextOffsetPageParam,
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
