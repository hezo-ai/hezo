import {
	type ConnectorProbeError,
	type ConnectorStatus,
	connectorNeedsHuman,
	connectorStatus,
	type LinkedRepo,
	type McpMethodInfo,
	type MethodAccessSummary,
} from '@hezo/shared';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { api, nextOffsetPageParam } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';
import { INSTANCE_CONNECTORS_KEY } from './use-instance-connectors';

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
	/** Lowercased identifier + title of the task that requested this connector,
	 * for linking back to it from the Connectors page. Populated by the project
	 * connectors list route (null when not agent-requested). */
	created_by_task_identifier?: string | null;
	created_by_task_title?: string | null;
	activated_at: string | null;
	revoked_at: string | null;
	auth_error: string | null;
	/**
	 * When Hezo last probed the MCP server, of any outcome; null means never.
	 * A hosted connector carrying no credential reaches agent runs only while its
	 * most recent probe completed the handshake.
	 */
	probed_at: string | null;
	/** Why that probe failed; null when it completed the MCP handshake. */
	probe_error: ConnectorProbeError | null;
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
	/** Git repos authenticating through this connector's OAuth connection, across
	 * every project - a global connection is by definition the shared one.
	 * Removing the connector leaves these working and strips its MCP tools from
	 * every run, so the confirmation names them. `[]`, never null. */
	linked_repos?: LinkedRepo[];
	/** Allowlist of the MCP methods agents may call, or `null` for no
	 * restriction. See {@link ConnectorMethods} on why the two differ. */
	enabled_methods?: string[] | null;
	/** Cached catalog of what the server advertises; null if never listed. */
	discovered_methods?: McpMethodInfo[] | null;
	methods_listed_at?: string | null;
	requested_access?: 'read' | 'write' | null;
}

// The ladder lives in @hezo/shared so the web, the server and the
// `list_connectors` MCP tool cannot disagree on what "connected" means. Both are
// re-exported here so the existing importers keep their import path.
export { type ConnectorStatus, connectorStatus };

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
			// Keep polling in every state a human is actively trying to fix -
			// `degraded` included, since that is precisely when they are clicking
			// Reconnect and waiting for the card to go green.
			return connectorNeedsHuman(connectorStatus(data)) ? 10_000 : false;
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

export interface ConnectorHealth {
	/** Connectors that were working and whose credential has stopped being accepted. */
	degraded: { id: string; name: string; display_name: string | null }[];
	count: number;
}

/**
 * Broken-connector count for the project banner. Its own endpoint rather than a
 * filter over the paginated connectors list: whether an operator finds out a
 * connector died must not depend on which page its row landed on.
 */
export function useConnectorHealth(projectId: string) {
	return useQuery({
		queryKey: queryKeys.projects.connectorHealth(projectId),
		queryFn: () => api.get<ConnectorHealth>(`/api/projects/${projectId}/connectors/health`),
	});
}

export function useConnectors(
	projectId: string,
	filterProjectId?: string,
	options?: { perPage?: number },
) {
	const perPage = options?.perPage ?? 50;
	return useInfiniteQuery({
		queryKey: queryKeys.projects.connectorsInfinite(projectId, {
			filter: filterProjectId ?? null,
			per_page: String(perPage),
		}),
		initialPageParam: 1,
		queryFn: ({ pageParam }) =>
			api.getPaginated<Connector>(`/api/projects/${projectId}/connectors`, {
				project_id: filterProjectId,
				page: String(pageParam),
				per_page: String(perPage),
			}),
		getNextPageParam: nextOffsetPageParam,
	});
}

export function useCreateConnector(projectId: string) {
	return useMutation({
		mutationFn: (data: CreateConnectorPayload) =>
			api.post<Connector>(`/api/projects/${projectId}/connectors`, data),
		// The list is a paginated infinite query; invalidate + refetch rather than
		// splice a flat array into an InfiniteData cache.
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.connectors(projectId) });
		},
	});
}

export function useDeleteConnector(projectId: string) {
	return useMutation({
		mutationFn: (id: string) => api.delete(`/api/projects/${projectId}/connectors/${id}`),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.connectors(projectId) });
		},
	});
}

/**
 * Which of an MCP server's methods this connector exposes to agents.
 *
 * `enabled_methods` is `null` when the connector is unrestricted, which is not
 * the same as a list naming every method — an unrestricted connector picks up
 * methods the server adds later, a restricted one does not. The UI must keep
 * that distinction rather than normalising `null` into a full array.
 */
export interface ConnectorMethods {
	connector_id: string;
	kind: 'saas' | 'local' | 'api';
	methods: McpMethodInfo[];
	enabled_methods: string[] | null;
	/** When the catalog was last fetched; null if the methods were never listed. */
	methods_listed_at: string | null;
	/** The access level the agent that registered this connector asked for. */
	requested_access: 'read' | 'write' | null;
	summary: MethodAccessSummary;
}

/**
 * Which connectors surface a methods hook is talking to.
 *
 * A project slug scopes to that project's Connectors page. `null` means the
 * **global** Settings → Connectors page, which is admin-only and unscoped — and
 * is the only place an "All projects" connector's allowlist can be edited, since
 * such a connector is read-only from every project page.
 */
export type ConnectorMethodsScope = string | null;

function methodsPath(scope: ConnectorMethodsScope, connectorId: string | undefined): string {
	return scope === null
		? `/api/connectors/${connectorId}/methods`
		: `/api/projects/${scope}/connectors/${connectorId}/methods`;
}

function methodsKey(scope: ConnectorMethodsScope, connectorId: string | null) {
	return scope === null
		? queryKeys.adminConnectorMethods(connectorId)
		: queryKeys.projects.connectorMethods(scope, connectorId);
}

export function useConnectorMethods(
	scope: ConnectorMethodsScope,
	connectorId: string | undefined,
	enabled = true,
) {
	return useQuery({
		queryKey: methodsKey(scope, connectorId ?? null),
		queryFn: () => api.get<ConnectorMethods>(methodsPath(scope, connectorId)),
		enabled: enabled && !!connectorId,
	});
}

/**
 * Save a connector's method allowlist (`null` clears the restriction).
 * Response-driven, never optimistic: this is a security control, so the UI must
 * not show an agent's access as narrowed before the server has actually stored
 * it.
 */
export function useUpdateConnectorMethods(scope: ConnectorMethodsScope) {
	return useMutation({
		mutationFn: ({
			connectorId,
			enabledMethods,
		}: {
			connectorId: string;
			enabledMethods: string[] | null;
		}) =>
			api.patch<Connector>(methodsPath(scope, connectorId), {
				enabled_methods: enabledMethods,
			}),
		onSuccess: (updated) => {
			queryClient.invalidateQueries({ queryKey: methodsKey(scope, updated.id) });
			if (scope === null) {
				// The admin list carries enabled_methods/discovered_methods per row and
				// is what the badge falls back to, so it has to refetch. (The reverse
				// import is type-only and erased, so this is not a runtime cycle.)
				queryClient.invalidateQueries({ queryKey: INSTANCE_CONNECTORS_KEY });
				return;
			}
			queryClient.setQueryData<Connector>(
				queryKeys.projects.connectorDetail(scope, updated.id),
				updated,
			);
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.connectors(scope) });
		},
	});
}

/**
 * Re-ask the server what it advertises. Invalidate-and-refetch rather than
 * response-driven: the round trip goes out to a third-party server, so how long
 * it takes and what comes back are both the server's call.
 */
export function useRefreshConnectorMethods(scope: ConnectorMethodsScope) {
	return useMutation({
		mutationFn: (connectorId: string) =>
			api.post<ConnectorMethods>(`${methodsPath(scope, connectorId)}/refresh`, {}),
		onSuccess: (_data, connectorId) => {
			queryClient.invalidateQueries({ queryKey: methodsKey(scope, connectorId) });
			queryClient.invalidateQueries({
				queryKey: scope === null ? INSTANCE_CONNECTORS_KEY : queryKeys.projects.connectors(scope),
			});
		},
	});
}
