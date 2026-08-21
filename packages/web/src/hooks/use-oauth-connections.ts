import type { LinkedRepo } from '@hezo/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';
import type { Connector } from './use-connectors';

export interface OAuthConnection {
	id: string;
	provider: string;
	provider_account_id: string;
	provider_account_label: string;
	scopes: string[];
	expires_at: string | null;
	metadata: Record<string, unknown>;
	/** Owning project, or null for a global ("all projects") connection. */
	project_id?: string | null;
	/** Git repos this connection authenticates, across every project.
	 * Disconnecting deletes the connection outright and nulls their reference, so
	 * those remotes fall back to anonymous clone. `[]`, never null. */
	linked_repos?: LinkedRepo[];
	created_at: string;
	updated_at: string;
}

export interface AuthStartResult {
	/**
	 * Authorize URL to open in a popup, or null when the MCP server advertises no
	 * OAuth (public / header-authenticated) — a normal outcome, not an error: the
	 * connector is left untouched and can be connected with a pasted API key.
	 */
	auth_url: string | null;
	reason?: string;
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

/**
 * A bundled OAuth-provider descriptor exposed by GET /api/connectors/oauth-providers.
 * Public data only (no secrets) — populates the generic OAuth-broker form's
 * provider dropdown so an operator gets sane endpoint/scope defaults.
 */
export interface OAuthProviderDescriptor {
	id: string;
	authorize_url?: string;
	device_code_url?: string;
	token_url: string;
	scopes: string[];
	client_type?: string;
	allowed_hosts: string[];
}

/** Form fields the broker device-flow start accepts. */
export interface BrokerDeviceStartInput {
	connectorId: string;
	provider_id?: string;
	client_id: string;
	client_secret?: string;
	device_code_url?: string;
	token_url?: string;
	scopes?: string[];
	allowed_hosts?: string[];
}

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
		onSettled: () => {
			// auth-start mutates the row on every path — restores a revoked connector,
			// persists config.dcr on a successful DCR walk, records auth_error on
			// failure — so refresh the list to reflect the new status either way.
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.connectors(projectId) });
		},
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
		queryClient.invalidateQueries({ queryKey: queryKeys.projects.connectors(projectId) });
	}
	return json.data as DeviceFlowPollResult;
}

/** The bundled OAuth-provider descriptors used by the generic OAuth-broker form. */
export function useOAuthProviders() {
	return useQuery({
		queryKey: queryKeys.oauthProviders(),
		queryFn: () => api.get<OAuthProviderDescriptor[]>('/api/connectors/oauth-providers'),
		staleTime: 60 * 60 * 1000, // bundled + static; effectively immutable per build
	});
}

/**
 * Start the generic OAuth device flow (RFC 8628) against an `api` connector: the
 * operator picks a bundled provider descriptor (or supplies endpoints directly)
 * plus a client id / secret. The refresh token + client secret stay host-side;
 * only the short-lived access token is later surfaced to a run.
 */
export function useBrokerDeviceStart(projectId: string) {
	return useMutation({
		mutationFn: ({ connectorId, ...form }: BrokerDeviceStartInput) =>
			api.post<DeviceFlowStart>(
				`/api/projects/${projectId}/connectors/${connectorId}/oauth-device/start`,
				form,
			),
	});
}

/**
 * Poll a broker device flow once. Mirrors {@link pollDeviceFlow}: the server
 * returns 202 with a pending status until the user authorizes, so it reads the
 * envelope directly and surfaces the pending/success discriminant.
 */
export async function pollBrokerDeviceFlow(
	projectId: string,
	connectorId: string,
	flowId: string,
): Promise<DeviceFlowPollResult> {
	const token = api.getToken();
	const res = await fetch(
		`/api/projects/${projectId}/connectors/${connectorId}/oauth-device/poll`,
		{
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(token ? { Authorization: `Bearer ${token}` } : {}),
			},
			body: JSON.stringify({ flow_id: flowId }),
		},
	);
	const json = (await res.json()) as { data?: DeviceFlowPollResult; error?: { message: string } };
	if (!res.ok && res.status !== 202) {
		throw new Error(json.error?.message ?? `device poll failed (${res.status})`);
	}
	if (json.data?.status === 'success') {
		queryClient.invalidateQueries({ queryKey: queryKeys.projects.oauthConnections(projectId) });
		queryClient.invalidateQueries({ queryKey: queryKeys.projects.connectors(projectId) });
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
			api.post<Connector>(`/api/projects/${projectId}/connectors/ensure`, {
				provider_id: providerId,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.connectors(projectId) });
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
