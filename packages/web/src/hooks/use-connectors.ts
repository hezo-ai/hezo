import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';

export interface Connector {
	id: string;
	name: string;
	display_name: string | null;
	kind: 'saas' | 'local' | 'api';
	config: Record<string, unknown>;
	oauth_connection_id: string | null;
	/** Vault secret holding a pasted API key, for connectors whose provider
	 * exposes no OAuth. Set once a key is provided; the descriptor emits a
	 * placeholder for it. */
	api_key_secret_id: string | null;
	/** Owning project, or null for a global ("all projects") connector. */
	project_id: string | null;
	install_status: 'pending' | 'installed' | 'failed';
	install_error: string | null;
	skill_id: string | null;
	created_by_task_id: string | null;
	activated_at: string | null;
	revoked_at: string | null;
	auth_error: string | null;
	created_at: string;
	updated_at: string;
	/** Linked OAuth account's username/label (e.g. GitHub login), when connected. */
	oauth_account_label?: string | null;
	/** Owning project's name/slug — populated only by the admin cross-project list. */
	project_name?: string | null;
	project_slug?: string | null;
	/** The credential(s) this connector uses — its pasted API-key secret or the
	 * access token of its OAuth connection. Populated by the list/detail routes. */
	credentials?: { id: string; name: string }[];
}

export type ConnectorStatus = 'pending' | 'active' | 'failed' | 'revoked';

export function connectorStatus(c: Connector): ConnectorStatus {
	if (c.revoked_at) return 'revoked';
	if (c.auth_error && !c.activated_at) return 'failed';
	if (c.oauth_connection_id && c.activated_at) return 'active';
	// API-key connectors (provider exposes no OAuth) store a pasted key in the
	// vault and reference it via api_key_secret_id; active once stamped.
	if (c.api_key_secret_id && c.activated_at) return 'active';
	// Local (stdio) connectors authenticate via credential placeholders
	// (__HEZO_SECRET_*__ — e.g. a username/password login that fetches a token),
	// not OAuth. There is no oauth_connection_id/activated_at handshake to
	// complete, so a non-revoked, non-failed local row is connected the moment it
	// exists — never leave it stuck on "Pending connect" offering an OAuth flow.
	if (c.kind === 'local') return 'active';
	return 'pending';
}

export function useConnector(projectId: string, connectorId: string | undefined) {
	return useQuery({
		queryKey: queryKeys.projects.connectorDetail(projectId, connectorId ?? null),
		queryFn: () => api.get<Connector>(`/api/projects/${projectId}/connectors/${connectorId}`),
		enabled: !!connectorId,
		// Fallback poll while pending — WebSocket invalidation and the
		// hezo-oauth-success postMessage are the primary update channels;
		// this catches the rare case where both miss. 10s is conservative
		// enough not to dogpile the proxy under load.
		refetchInterval: (query) => {
			const data = query.state.data as Connector | undefined;
			if (!data) return 10_000;
			const status = connectorStatus(data);
			return status === 'pending' || status === 'failed' ? 10_000 : false;
		},
	});
}

export interface SetConnectorApiKeyPayload {
	value: string;
	/** Optional header override (default `Authorization`). */
	header?: string;
	/** Optional scheme prefix override (default `Bearer `; pass '' for a raw key). */
	scheme?: string;
}

/**
 * Attach a pasted API key to a connector whose provider exposes no OAuth.
 * Response-driven (security-sensitive) — the connector must never optimistically
 * appear connected before the server has stored the key.
 */
export function useSetConnectorApiKey(projectId: string) {
	return useMutation({
		mutationFn: ({
			connectorId,
			payload,
		}: {
			connectorId: string;
			payload: SetConnectorApiKeyPayload;
		}) =>
			api.post<Connector>(`/api/projects/${projectId}/connectors/${connectorId}/api-key`, payload),
		onSuccess: (updated) => {
			queryClient.setQueryData<Connector>(
				queryKeys.projects.connectorDetail(projectId, updated.id),
				updated,
			);
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.connectors(projectId) });
		},
	});
}

export function useRevokeConnector(projectId: string) {
	return useMutation({
		mutationFn: (connectorId: string) =>
			api.post<Connector>(`/api/projects/${projectId}/connectors/${connectorId}/revoke`, {}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.connectors(projectId) });
		},
	});
}

export interface CreateConnectorPayload {
	name: string;
	kind: 'saas' | 'local' | 'api';
	config: Record<string, unknown>;
}

export function useConnectors(projectId: string, filterProjectId?: string) {
	const qs = filterProjectId ? `?project_id=${encodeURIComponent(filterProjectId)}` : '';
	return useQuery({
		queryKey: queryKeys.projects.connectorsFiltered(projectId, filterProjectId ?? null),
		queryFn: () => api.get<Connector[]>(`/api/projects/${projectId}/connectors${qs}`),
	});
}

export function useCreateConnector(projectId: string) {
	return useMutation({
		mutationFn: (data: CreateConnectorPayload) =>
			api.post<Connector>(`/api/projects/${projectId}/connectors`, data),
		onSuccess: (created) => {
			queryClient.setQueryData<Connector[]>(
				queryKeys.projects.connectorsFiltered(projectId, null),
				(prev) => (prev ? [...prev.filter((c) => c.id !== created.id), created] : [created]),
			);
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.connectors(projectId) });
		},
	});
}

export function useDeleteConnector(projectId: string) {
	return useMutation({
		mutationFn: (id: string) => api.delete(`/api/projects/${projectId}/connectors/${id}`),
		onSuccess: (_, id) => {
			queryClient.setQueriesData<Connector[]>(
				{ queryKey: queryKeys.projects.connectors(projectId) },
				(prev) => (prev ? prev.filter((c) => c.id !== id) : prev),
			);
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.connectors(projectId) });
		},
	});
}
