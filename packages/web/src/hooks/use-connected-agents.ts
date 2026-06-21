import type { ConnectedAgentStatus } from '@hezo/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

// Connected agents are instance-global external MCP clients. Approving or
// disconnecting one changes a security boundary (full instance access), so the
// mutations invalidate + refetch — never optimistic — to reflect only the
// server-confirmed state. Admin (superuser) only.
export const INSTANCE_CONNECTED_AGENTS_KEY = ['instance', 'connected-agents'] as const;

export interface ConnectedAgent {
	id: string;
	name: string;
	client_info: Record<string, unknown>;
	prefix: string;
	status: ConnectedAgentStatus;
	approved_at: string | null;
	last_used_at: string | null;
	created_at: string;
}

export function useConnectedAgents() {
	return useQuery({
		queryKey: INSTANCE_CONNECTED_AGENTS_KEY,
		queryFn: () => api.get<ConnectedAgent[]>('/api/agent-connections'),
	});
}

export function useApproveConnectedAgent() {
	return useMutation({
		mutationFn: (id: string) => api.post<ConnectedAgent>(`/api/agent-connections/${id}/approve`),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: INSTANCE_CONNECTED_AGENTS_KEY });
		},
	});
}

export function useDisconnectConnectedAgent() {
	return useMutation({
		mutationFn: (id: string) => api.delete(`/api/agent-connections/${id}`),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: INSTANCE_CONNECTED_AGENTS_KEY });
		},
	});
}
