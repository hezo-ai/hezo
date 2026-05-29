import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export interface McpConnection {
	id: string;
	team_id: string;
	project_id: string | null;
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

export function useMcpConnection(teamId: string, connectorId: string | undefined) {
	return useQuery({
		queryKey: ['teams', teamId, 'mcp-connections', 'detail', connectorId ?? null],
		queryFn: () => api.get<McpConnection>(`/api/teams/${teamId}/mcp-connections/${connectorId}`),
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

export function useConnectorAuthStart(teamId: string) {
	return useMutation({
		mutationFn: (connectorId: string) =>
			api.post<{ auth_url: string }>(
				`/api/teams/${teamId}/connectors/${connectorId}/auth-start`,
				{},
			),
	});
}

export function useRevokeConnector(teamId: string) {
	return useMutation({
		mutationFn: (connectorId: string) =>
			api.post<McpConnection>(`/api/teams/${teamId}/mcp-connections/${connectorId}/revoke`, {}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'mcp-connections'] });
		},
	});
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
		onSuccess: (created) => {
			queryClient.setQueryData<McpConnection[]>(
				['teams', teamId, 'mcp-connections', created.project_id ?? null],
				(prev) => (prev ? [...prev.filter((c) => c.id !== created.id), created] : [created]),
			);
			queryClient.invalidateQueries({
				queryKey: ['teams', teamId, 'mcp-connections'],
			});
		},
	});
}

export function useDeleteMcpConnection(teamId: string) {
	return useMutation({
		mutationFn: (id: string) => api.delete(`/api/teams/${teamId}/mcp-connections/${id}`),
		onSuccess: (_, id) => {
			queryClient.setQueriesData<McpConnection[]>(
				{ queryKey: ['teams', teamId, 'mcp-connections'] },
				(prev) => (prev ? prev.filter((c) => c.id !== id) : prev),
			);
			queryClient.invalidateQueries({
				queryKey: ['teams', teamId, 'mcp-connections'],
			});
		},
	});
}
