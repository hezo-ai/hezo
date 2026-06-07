import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { useInvalidatingMutation } from './use-invalidating-mutation';
import { useResponseMutation } from './use-response-mutation';

/** Prefix key — invalidating it re-flows every filter-scoped list under the route project. */
const baseKey = (projectId: string) => ['projects', projectId, 'mcp-connections'] as const;
const scopedKey = (projectId: string, filterProjectId: string | null) =>
	['projects', projectId, 'mcp-connections', filterProjectId] as const;

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

export function useMcpConnection(projectId: string, connectorId: string | undefined) {
	return useQuery({
		queryKey: ['projects', projectId, 'mcp-connections', 'detail', connectorId ?? null],
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
	// Security-sensitive: must invalidate + refetch, never optimistically appear
	// revoked.
	return useInvalidatingMutation<string, McpConnection>({
		mutationFn: (connectorId) =>
			api.post<McpConnection>(
				`/api/projects/${projectId}/mcp-connections/${connectorId}/revoke`,
				{},
			),
		invalidate: [baseKey(projectId)],
	});
}

export interface CreateMcpConnectionPayload {
	name: string;
	kind: 'saas' | 'local';
	config: Record<string, unknown>;
	project_id?: string;
}

export function useMcpConnections(projectId: string, filterProjectId?: string) {
	const qs = filterProjectId ? `?project_id=${encodeURIComponent(filterProjectId)}` : '';
	return useQuery({
		queryKey: ['projects', projectId, 'mcp-connections', filterProjectId ?? null],
		queryFn: () => api.get<McpConnection[]>(`/api/projects/${projectId}/mcp-connections${qs}`),
	});
}

export function useCreateMcpConnection(projectId: string) {
	// Response-driven: the server sets install_status (and may upsert), seeding
	// the filter-scoped list from the response keyed by the returned project_id.
	return useResponseMutation<CreateMcpConnectionPayload, McpConnection, McpConnection[]>({
		mutationFn: (data) =>
			api.post<McpConnection>(`/api/projects/${projectId}/mcp-connections`, data),
		queryKey: (_data, created) => scopedKey(projectId, created.project_id ?? null),
		merge: (prev, created) =>
			prev ? [...prev.filter((c) => c.id !== created.id), created] : [created],
		invalidateOnSettled: [baseKey(projectId)],
	});
}

export function useDeleteMcpConnection(projectId: string) {
	return useInvalidatingMutation<string, unknown>({
		mutationFn: (id) => api.delete(`/api/projects/${projectId}/mcp-connections/${id}`),
		invalidate: [baseKey(projectId)],
		onSuccess: (_data, id) => {
			// Prune from every filter-scoped list immediately (setQueriesData spans
			// the prefix); the invalidate above refetches them.
			queryClient.setQueriesData<McpConnection[]>({ queryKey: baseKey(projectId) }, (prev) =>
				prev ? prev.filter((c) => c.id !== id) : prev,
			);
		},
	});
}
