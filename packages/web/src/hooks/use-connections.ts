import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export interface Connection {
	id: string;
	platform: string;
	status: string;
	scopes: string | null;
	metadata: Record<string, unknown> | null;
	token_expires_at: string | null;
	connected_at: string;
}

export function useConnections(companyId: string) {
	return useQuery({
		queryKey: ['companies', companyId, 'connections'],
		queryFn: () => api.get<Connection[]>(`/api/companies/${companyId}/connections`),
	});
}

export function useStartConnection(companyId: string) {
	return useMutation({
		mutationFn: (platform: string) =>
			api.post<{ auth_url: string; state: string }>(
				`/api/companies/${companyId}/connections/${platform}/start`,
			),
	});
}

export function useDeleteConnection(companyId: string) {
	return useMutation({
		mutationFn: (connectionId: string) =>
			api.delete(`/api/companies/${companyId}/connections/${connectionId}`),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'connections'] }),
	});
}
