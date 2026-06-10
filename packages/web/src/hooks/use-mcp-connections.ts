import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';

export interface McpConnection {
	id: string;
	name: string;
	display_name: string | null;
	kind: 'saas' | 'local';
	config: Record<string, unknown>;
	oauth_connection_id: string | null;
	install_status: 'pending' | 'installed' | 'failed';
	install_error: string | null;
	skill_doc_id: string | null;
	created_by_task_id: string | null;
	activated_at: string | null;
	revoked_at: string | null;
	auth_error: string | null;
	created_at: string;
	updated_at: string;
}

export type ConnectorStatus = 'pending' | 'active' | 'failed' | 'revoked';

export function connectorStatus(c: McpConnection): ConnectorStatus {
	if (c.revoked_at) return 'revoked';
	if (c.auth_error && !c.activated_at) return 'failed';
	if (c.oauth_connection_id && c.activated_at) return 'active';
	return 'pending';
}

export function useMcpConnection(projectId: string, connectorId: string | undefined) {
	return useQuery({
		queryKey: queryKeys.projects.mcpConnectionDetail(projectId, connectorId ?? null),
		queryFn: () =>
			api.get<McpConnection>(`/api/projects/${projectId}/mcp-connections/${connectorId}`),
		enabled: !!connectorId,
		// Fallback poll while pending — WebSocket invalidation and the
		// hezo-oauth-success postMessage are the primary update channels;
		// this catches the rare case where both miss. 10s is conservative
		// enough not to dogpile the proxy under load.
		refetchInterval: (query) => {
			const data = query.state.data as McpConnection | undefined;
			if (!data) return 10_000;
			const status = connectorStatus(data);
			return status === 'pending' || status === 'failed' ? 10_000 : false;
		},
	});
}

export function useRevokeConnector(projectId: string) {
	return useMutation({
		mutationFn: (connectorId: string) =>
			api.post<McpConnection>(
				`/api/projects/${projectId}/mcp-connections/${connectorId}/revoke`,
				{},
			),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.mcpConnections(projectId) });
		},
	});
}

export interface CreateMcpConnectionPayload {
	name: string;
	kind: 'saas' | 'local';
	config: Record<string, unknown>;
}

export function useMcpConnections(projectId: string, filterProjectId?: string) {
	const qs = filterProjectId ? `?project_id=${encodeURIComponent(filterProjectId)}` : '';
	return useQuery({
		queryKey: queryKeys.projects.mcpConnectionsFiltered(projectId, filterProjectId ?? null),
		queryFn: () => api.get<McpConnection[]>(`/api/projects/${projectId}/mcp-connections${qs}`),
	});
}

export function useCreateMcpConnection(projectId: string) {
	return useMutation({
		mutationFn: (data: CreateMcpConnectionPayload) =>
			api.post<McpConnection>(`/api/projects/${projectId}/mcp-connections`, data),
		onSuccess: (created) => {
			queryClient.setQueryData<McpConnection[]>(
				queryKeys.projects.mcpConnectionsFiltered(projectId, null),
				(prev) => (prev ? [...prev.filter((c) => c.id !== created.id), created] : [created]),
			);
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.mcpConnections(projectId) });
		},
	});
}

export function useDeleteMcpConnection(projectId: string) {
	return useMutation({
		mutationFn: (id: string) => api.delete(`/api/projects/${projectId}/mcp-connections/${id}`),
		onSuccess: (_, id) => {
			queryClient.setQueriesData<McpConnection[]>(
				{ queryKey: queryKeys.projects.mcpConnections(projectId) },
				(prev) => (prev ? prev.filter((c) => c.id !== id) : prev),
			);
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.mcpConnections(projectId) });
		},
	});
}
