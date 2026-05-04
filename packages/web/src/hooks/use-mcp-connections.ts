import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export interface McpConnection {
	id: string;
	company_id: string;
	project_id: string | null;
	name: string;
	kind: 'saas' | 'local';
	config: Record<string, unknown>;
	install_status: 'pending' | 'installed' | 'failed';
	install_error: string | null;
	created_at: string;
	updated_at: string;
}

export interface CreateMcpConnectionPayload {
	name: string;
	kind: 'saas' | 'local';
	config: Record<string, unknown>;
	project_id?: string;
}

export function useMcpConnections(companyId: string, projectId?: string) {
	const qs = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
	return useQuery({
		queryKey: ['companies', companyId, 'mcp-connections', projectId ?? null],
		queryFn: () => api.get<McpConnection[]>(`/api/companies/${companyId}/mcp-connections${qs}`),
	});
}

export function useCreateMcpConnection(companyId: string) {
	return useMutation({
		mutationFn: (data: CreateMcpConnectionPayload) =>
			api.post<McpConnection>(`/api/companies/${companyId}/mcp-connections`, data),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ['companies', companyId, 'mcp-connections'],
			});
		},
	});
}

export function useDeleteMcpConnection(companyId: string) {
	return useMutation({
		mutationFn: (id: string) => api.delete(`/api/companies/${companyId}/mcp-connections/${id}`),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ['companies', companyId, 'mcp-connections'],
			});
		},
	});
}
