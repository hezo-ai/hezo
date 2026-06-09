import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';
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

export interface DeviceFlowStart {
	flow_id: string;
	user_code: string;
	verification_uri: string;
	expires_in: number;
	interval: number;
}

export interface DeviceFlowSuccess {
	status: 'success';
	connection: { id: string; provider_account_label: string };
}

export interface DeviceFlowPending {
	status: 'pending';
	retry_after: number;
}

export type DeviceFlowPollResult = DeviceFlowSuccess | DeviceFlowPending;

export function useOAuthConnections(projectId: string) {
	return useQuery({
		queryKey: queryKeys.projects.oauthConnections(projectId),
		queryFn: () => api.get<OAuthConnection[]>(`/api/projects/${projectId}/oauth-connections`),
	});
}

export function useDeleteOAuthConnection(projectId: string) {
	return useMutation({
		mutationFn: (id: string) => api.delete(`/api/projects/${projectId}/oauth-connections/${id}`),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.projects.oauthConnections(projectId),
			});
		},
	});
}

export function useAuthStart(projectId: string) {
	return useMutation({
		mutationFn: (connectorId: string) =>
			api.post<AuthStartResult>(`/api/projects/${projectId}/auth-start`, {
				connector_id: connectorId,
			}),
	});
}

/**
 * Start the GitHub device flow against an already-materialized connector.
 * GitHub can't use the DCR-based `auth-start` path (its Authorization Server
 * supports neither Dynamic Client Registration nor a redirect-friendly public
 * client), so it gets a device code the user enters at github.com/login/device.
 */
export function useDeviceStart(projectId: string) {
	return useMutation({
		mutationFn: (connectorId: string) =>
			api.post<DeviceFlowStart>(
				`/api/projects/${projectId}/connectors/${connectorId}/device/start`,
				{},
			),
	});
}

/**
 * Poll a GitHub device flow once. The server returns 202 with a pending status
 * while the user hasn't authorized yet, so this can't use `api.post` (which
 * treats non-2xx-data uniformly); it reads the envelope directly and surfaces
 * the pending/success discriminant to the caller's polling loop.
 */
export async function pollDeviceFlow(
	projectId: string,
	connectorId: string,
	flowId: string,
): Promise<DeviceFlowPollResult> {
	const token = api.getToken();
	const res = await fetch(`/api/projects/${projectId}/connectors/${connectorId}/device/poll`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify({ flow_id: flowId }),
	});
	const json = (await res.json()) as { data?: DeviceFlowPollResult; error?: { message: string } };
	if (!res.ok && res.status !== 202) {
		throw new Error(json.error?.message ?? `device poll failed (${res.status})`);
	}
	if (json.data?.status === 'success') {
		queryClient.invalidateQueries({ queryKey: queryKeys.projects.oauthConnections(projectId) });
		queryClient.invalidateQueries({ queryKey: queryKeys.projects.mcpConnections(projectId) });
	}
	return json.data as DeviceFlowPollResult;
}

/**
 * Idempotently materializes a connector row from the capability registry,
 * returning the existing or newly-created row. Used by the project-settings
 * GitHub section and the Connectors-page GitHub row so neither has to know
 * how to construct the connector — they just say "ensure github" then call
 * useAuthStart with the resulting id.
 */
export function useEnsureConnector(projectId: string) {
	return useMutation({
		mutationFn: (providerId: string) =>
			api.post<McpConnection>(`/api/projects/${projectId}/connectors/ensure`, {
				provider_id: providerId,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.mcpConnections(projectId) });
		},
	});
}

export interface ScopeStatus {
	sufficient: boolean;
	missing: string[];
	required: string[];
}

export function useConnectionScopeStatus(
	projectId: string,
	connectionId: string | null | undefined,
) {
	return useQuery({
		queryKey: queryKeys.projects.oauthConnectionScopeStatus(projectId, connectionId),
		queryFn: () =>
			api.get<ScopeStatus>(
				`/api/projects/${projectId}/oauth-connections/${connectionId}/scope-status`,
			),
		enabled: !!connectionId,
	});
}
