import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import type { McpConnection } from './use-mcp-connections';

// Instance-level connectors (mcp_connections with team_id NULL) are shared with
// every team. Only the Admin (superuser) manages them, via the un-prefixed
// /api/mcp-connections routes. SaaS (remote URL) only — local MCPs carry
// per-container install state and stay per-team.
export const INSTANCE_CONNECTORS_KEY = ['instance', 'mcp-connections'] as const;

export interface CreateInstanceConnectorPayload {
	name: string;
	display_name?: string;
	kind: 'saas';
	config: { url: string; headers?: Record<string, string> };
}

export function useInstanceConnectors() {
	return useQuery({
		queryKey: INSTANCE_CONNECTORS_KEY,
		queryFn: () => api.get<McpConnection[]>('/api/mcp-connections'),
	});
}

export function useCreateInstanceConnector() {
	return useMutation({
		mutationFn: (data: CreateInstanceConnectorPayload) =>
			api.post<McpConnection>('/api/mcp-connections', data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: INSTANCE_CONNECTORS_KEY });
		},
	});
}

export function useDeleteInstanceConnector() {
	return useMutation({
		mutationFn: (id: string) => api.delete(`/api/mcp-connections/${id}`),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: INSTANCE_CONNECTORS_KEY });
		},
	});
}
