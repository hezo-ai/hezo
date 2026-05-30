import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import type { McpConnection } from './use-mcp-connections';

export interface OAuthConnection {
	id: string;
	provider: string;
	provider_account_id: string;
	provider_account_label: string;
	scopes: string[];
	expires_at: string | null;
	metadata: Record<string, unknown>;
	created_at: string;
	updated_at: string;
}

export interface AuthStartResult {
	auth_url: string;
}

export function useOAuthConnections(teamId: string) {
	return useQuery({
		queryKey: ['teams', teamId, 'oauth-connections'],
		queryFn: () => api.get<OAuthConnection[]>(`/api/teams/${teamId}/oauth-connections`),
	});
}

export function useDeleteOAuthConnection(teamId: string) {
	return useMutation({
		mutationFn: (id: string) => api.delete(`/api/teams/${teamId}/oauth-connections/${id}`),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ['teams', teamId, 'oauth-connections'],
			});
		},
	});
}

export function useAuthStart(teamId: string) {
	return useMutation({
		mutationFn: (connectorId: string) =>
			api.post<AuthStartResult>(`/api/teams/${teamId}/auth-start`, {
				connector_id: connectorId,
			}),
	});
}

/**
 * Idempotently materializes a connector row from the capability registry,
 * returning the existing or newly-created row. Used by the project-settings
 * GitHub section and the Connectors-page GitHub row so neither has to know
 * how to construct the connector — they just say "ensure github" then call
 * useAuthStart with the resulting id.
 */
export function useEnsureConnector(teamId: string) {
	return useMutation({
		mutationFn: (providerId: string) =>
			api.post<McpConnection>(`/api/teams/${teamId}/connectors/ensure`, {
				provider_id: providerId,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'mcp-connections'] });
		},
	});
}

export interface ScopeStatus {
	sufficient: boolean;
	missing: string[];
	required: string[];
}

export function useConnectionScopeStatus(teamId: string, connectionId: string | null | undefined) {
	return useQuery({
		queryKey: ['teams', teamId, 'oauth-connections', connectionId, 'scope-status'],
		queryFn: () =>
			api.get<ScopeStatus>(`/api/teams/${teamId}/oauth-connections/${connectionId}/scope-status`),
		enabled: !!connectionId,
	});
}
