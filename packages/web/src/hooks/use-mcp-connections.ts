import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export interface McpConnection {
	id: string;
	team_id: string;
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

export function useMcpConnections(teamId: string, projectId?: string) {
	const qs = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
	return useQuery({
		queryKey: ['teams', teamId, 'mcp-connections', projectId ?? null],
		queryFn: () => api.get<McpConnection[]>(`/api/teams/${teamId}/mcp-connections${qs}`),
	});
}

export function useCreateMcpConnection(teamId: string) {
	return useMutation({
		mutationFn: (data: CreateMcpConnectionPayload) =>
			api.post<McpConnection>(`/api/teams/${teamId}/mcp-connections`, data),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ['teams', teamId, 'mcp-connections'],
			});
		},
	});
}

export function useDeleteMcpConnection(teamId: string) {
	return useMutation({
		mutationFn: (id: string) => api.delete(`/api/teams/${teamId}/mcp-connections/${id}`),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ['teams', teamId, 'mcp-connections'],
			});
		},
	});
}
