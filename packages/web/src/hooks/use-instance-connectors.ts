import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import type { McpConnection } from './use-mcp-connections';

// The admin (superuser) connectors surface. Its list spans EVERY project's
// connectors plus global ("all projects") ones (project_id NULL), via the
// un-prefixed /api/mcp-connections routes, so it can render a per-project scope
// filter. Create targets the selected scope: a project_id, or none for a global
// connector. SaaS (remote URL) only — local MCPs carry per-container install
// state and are managed on the project.
export const INSTANCE_CONNECTORS_KEY = ['instance', 'mcp-connections'] as const;

export interface CreateInstanceConnectorPayload {
	name: string;
	display_name?: string;
	kind: 'saas';
	config: { url: string; headers?: Record<string, string> };
	/** Target project, or omitted/null for a global ("all projects") connector. */
	project_id?: string | null;
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

export interface InstanceAuthStartResult {
	/**
	 * Authorize URL to open in a popup, or null when the MCP server advertises
	 * no OAuth (public / header-authenticated) — a normal outcome, not an error.
	 */
	auth_url: string | null;
	reason?: string;
}

/**
 * Kick off the DCR OAuth flow for an instance connector. Mirrors the
 * project-scoped useAuthStart but against the admin surface, and its
 * `auth_url` is nullable (see InstanceAuthStartResult).
 */
export function useInstanceAuthStart() {
	return useMutation({
		mutationFn: (id: string) =>
			api.post<InstanceAuthStartResult>(`/api/mcp-connections/${id}/auth-start`, {}),
		onSettled: () => {
			// auth-start mutates the row on both paths (persists config.dcr on
			// success, auth_error on failure) — refresh statuses either way.
			queryClient.invalidateQueries({ queryKey: INSTANCE_CONNECTORS_KEY });
		},
	});
}
