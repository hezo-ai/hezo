import {
	ConnectorTransport,
	type McpInstallStatus,
	type McpMethodInfo,
	PLACEHOLDER_PROBE,
	SECRET_NAME_BODY,
} from '@hezo/shared';
import type { Db } from '../../db/database';
import { credentialPlaceholder } from '../../lib/credential-placeholder';
import { logger } from '../../logger';
import type { McpDescriptor } from '../runtime-adapters';

const log = logger.child('connectors');

export interface SaasConnectorConfig {
	url: string;
	headers?: Record<string, string>;
	/**
	 * DCR (RFC 7591) registration metadata stored after the connector's first
	 * auth-start. Lets re-authorization (after revoke/expiry) reuse the same
	 * client_id at the same Authorization Server without re-registering.
	 */
	dcr?: {
		client_id: string;
		authorization_server_url: string;
		authorization_endpoint: string;
		token_endpoint: string;
		scopes_supported?: string[];
	};
	/**
	 * API-key auth shape for connectors authenticated by a pasted key
	 * (`api_key_secret_id` set), used when the provider exposes no OAuth. Names
	 * the header the placeholder rides in and the scheme prefix. Both optional;
	 * default to `Authorization` / `Bearer ` (covers most MCP servers). The
	 * value is ALWAYS a `__HEZO_SECRET_*__` placeholder — never the raw key.
	 */
	apiKey?: {
		header?: string;
		scheme?: string;
	};
}

export interface LocalConnectorConfig {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	package?: string;
}

/**
 * A credentialed REST API the agent calls **directly** through the egress proxy —
 * no MCP server involved. Unlike saas/local there is no MCP descriptor: the agent
 * gets the `base_url`, the auth `placement`/`name`, and a `__HEZO_SECRET_*__`
 * placeholder (via {@link loadConnectorDescriptors}'s api_auth surfacing in
 * `list_connectors`), puts the placeholder in the header/query named by `auth`,
 * and calls `base_url`. The egress proxy substitutes the real key at request time,
 * scoped to `allowed_hosts`. The credential itself is NOT stored in config — it is
 * the `api_key_secret_id` vault link, same as an api-key-authenticated saas row.
 */
export interface ApiConnectorConfig {
	base_url: string;
	allowed_hosts: string[];
	auth: {
		/** Where the credential rides: an HTTP header, or a query-string parameter. */
		placement: 'header' | 'query';
		/** Header name (e.g. `Authorization`) or query param name (e.g. `api_key`). */
		name: string;
		/** Optional value prefix for a header placement (e.g. `Bearer `). */
		scheme?: string;
	};
	/** Optional link to the provider's REST API docs, surfaced to the agent + UI. */
	docs_url?: string;
}

export type ConnectorConfig = SaasConnectorConfig | LocalConnectorConfig | ApiConnectorConfig;

/**
 * Validate a raw `config` object as an {@link ApiConnectorConfig}. Shared by the
 * `add_connector` MCP tool and the connector-create REST routes so the two surfaces
 * enforce identical shape. Returns `{ ok: true, config }` with the normalized config
 * (trimmed strings, deduped hosts) or `{ ok: false, error }` with a human message.
 */
export function validateApiConnectorConfig(
	config: Record<string, unknown> | undefined,
): { ok: true; config: ApiConnectorConfig } | { ok: false; error: string } {
	const baseUrl = typeof config?.base_url === 'string' ? config.base_url.trim() : '';
	if (!baseUrl) return { ok: false, error: 'api connectors require config.base_url (string)' };
	let host = '';
	try {
		host = new URL(baseUrl).host;
	} catch {
		return { ok: false, error: 'config.base_url must be a valid URL' };
	}
	if (!host) return { ok: false, error: 'config.base_url must be a valid URL' };

	const rawHosts = (config as { allowed_hosts?: unknown }).allowed_hosts;
	if (
		!Array.isArray(rawHosts) ||
		rawHosts.length === 0 ||
		!rawHosts.every((h) => typeof h === 'string' && h.trim().length > 0)
	) {
		return { ok: false, error: 'api connectors require config.allowed_hosts (non-empty string[])' };
	}
	const allowedHosts = [...new Set(rawHosts.map((h) => (h as string).trim().toLowerCase()))];

	const auth = (config as { auth?: unknown }).auth;
	if (typeof auth !== 'object' || auth === null) {
		return { ok: false, error: 'api connectors require config.auth ({ placement, name })' };
	}
	const placement = (auth as { placement?: unknown }).placement;
	if (placement !== 'header' && placement !== 'query') {
		return { ok: false, error: "config.auth.placement must be 'header' or 'query'" };
	}
	const nameRaw = (auth as { name?: unknown }).name;
	const name = typeof nameRaw === 'string' ? nameRaw.trim() : '';
	if (!name) return { ok: false, error: 'config.auth.name is required' };
	const schemeRaw = (auth as { scheme?: unknown }).scheme;
	const scheme = typeof schemeRaw === 'string' ? schemeRaw : undefined;

	const docsRaw = (config as { docs_url?: unknown }).docs_url;
	const docsUrl =
		typeof docsRaw === 'string' && docsRaw.trim().length > 0 ? docsRaw.trim() : undefined;

	return {
		ok: true,
		config: {
			base_url: baseUrl,
			allowed_hosts: allowedHosts,
			auth: { placement, name, ...(scheme !== undefined ? { scheme } : {}) },
			...(docsUrl ? { docs_url: docsUrl } : {}),
		},
	};
}

export interface ConnectorRow {
	id: string;
	name: string;
	kind: ConnectorTransport;
	config: ConnectorConfig;
	oauth_connection_id: string | null;
	api_key_secret_id: string | null;
	install_status: McpInstallStatus;
	install_error: string | null;
	/**
	 * Allowlist of the server's method names this connector exposes, or `null`
	 * for **no restriction**. Never conflate the two: `null` means the run gets
	 * whatever the server advertises today *and* tomorrow, while a non-null list
	 * means an unrecognised new method is disabled until an operator enables it.
	 */
	enabled_methods: string[] | null;
	/** Cached `tools/list` catalog, or null when the server's methods have never
	 * been listed. Only used to derive the deny-list view of the allowlist. */
	discovered_methods: McpMethodInfo[] | null;
	created_at: string;
	updated_at: string;
	/** When Hezo last probed the server, of any outcome. Null means never. */
	probed_at: string | null;
	/** Why that probe failed; null when it completed the MCP handshake. */
	probe_error: string | null;
	/**
	 * A run would send a credential for this connector - it satisfies
	 * {@link SAAS_CREDENTIALED_SQL}, computed by the same expression the run gate
	 * reads so the two can never disagree. Meaningful for hosted rows only.
	 */
	credentialed: boolean;
}

/**
 * A hosted connector already carries a credential a run would send: a completed
 * OAuth connection, a pasted API key, or an operator-configured
 * `__HEZO_SECRET_*__` header the egress proxy substitutes at request time.
 *
 * The pattern is built from the shared grammar rather than written out, so the
 * predicate cannot drift from what the egress proxy actually substitutes.
 * `COALESCE` because a row with no `headers` key yields SQL NULL, and a NULL
 * inside a `NOT (...)` would quietly drop the row instead of matching nothing.
 */
export const SAAS_CREDENTIALED_SQL = `(
	oauth_connection_id IS NOT NULL
	OR api_key_secret_id IS NOT NULL
	OR COALESCE((config->'headers')::text, '') ~ '${PLACEHOLDER_PROBE}${SECRET_NAME_BODY}__'
)`;

/**
 * Load MCP connections exposed to an agent run. Scoped to the run's project: its
 * own connectors plus global ("all projects") ones. When a project and a global
 * connector share a name, the project's own wins (it shadows the global) — the
 * `ORDER BY … (project_id IS NULL) DESC` emits globals first so the last-write
 * Map keeps the project row.
 *
 * The invariant this query enforces: **an uncredentialed hosted connector
 * reaches a run only while Hezo's most recent probe of it completed the MCP
 * handshake with no credential.** A row that has never been probed, or whose
 * last probe failed, stays out - it would only 401 at handshake inside the
 * container, where nothing on this side can see it, and be handed over again on
 * the next run forever.
 */
export async function loadConnectorsForRun(
	db: Db,
	projectId?: string | null,
): Promise<ConnectorRow[]> {
	// Include every non-hosted row and every hosted row that carries a credential;
	// for the rest, require probe evidence. `probe_error IS NULL` alone is not
	// enough - it is the value a never-probed row also has, and "we have not
	// asked" is not "it answered".
	return selectConnectorsInScope(
		db,
		projectId,
		`AND (kind <> 'saas'
		      OR ${SAAS_CREDENTIALED_SQL}
		      OR (probed_at IS NOT NULL AND probe_error IS NULL))`,
	);
}

/**
 * Every connector in scope the user has not disconnected, whether or not a run
 * is given a descriptor for it.
 *
 * Used for the egress method allowlist rather than the descriptor set. An
 * operator who restricted a connector's methods restricted the *server*, and an
 * agent can reach a URL it read off `list_connectors` without a descriptor - so
 * withholding the descriptor must not also withhold the restriction. The
 * enforcement leg is deliberately wider than the injection leg.
 */
async function loadConnectorsInScope(db: Db, projectId?: string | null): Promise<ConnectorRow[]> {
	return selectConnectorsInScope(db, projectId, '');
}

/** The shared read behind both, differing only in the reachability predicate. */
async function selectConnectorsInScope(
	db: Db,
	projectId: string | null | undefined,
	gate: string,
): Promise<ConnectorRow[]> {
	const scopeClause = projectId != null ? `AND (project_id = $1 OR project_id IS NULL)` : '';
	const params = projectId != null ? [projectId] : [];
	const result = await db.query<ConnectorRow>(
		`SELECT id, name, kind::text AS kind,
		        config, oauth_connection_id, api_key_secret_id,
		        install_status::text AS install_status, install_error,
		        enabled_methods, discovered_methods,
		        created_at::text, updated_at::text,
		        probed_at::text AS probed_at, probe_error::text AS probe_error,
		        ${SAAS_CREDENTIALED_SQL} AS credentialed
		 FROM mcp_connections
		 WHERE revoked_at IS NULL
		   ${gate}
		   ${scopeClause}
		 ORDER BY name ASC, (project_id IS NULL) DESC`,
		params,
	);

	const out = new Map<string, ConnectorRow>();
	for (const row of result.rows) out.set(row.name, row);
	return [...out.values()];
}

/** A restricted connector's upstream host and the methods agents may call on it. */
export interface McpHostRestriction {
	/** Connector name, so a rejection can say which connector withheld the method. */
	connectorName: string;
	enabled: ReadonlySet<string>;
}

/** One hosted connector's identity on a bound host:port, as the egress proxy needs it. */
export interface McpHostConnector {
	id: string;
	name: string;
	/** The connector URL's pathname, normalised: no trailing slash except the bare root. */
	pathname: string;
	/** A run would send a credential for this connector (see `ConnectorRow.credentialed`). */
	credentialed: boolean;
}

/**
 * Everything the egress proxy knows about one upstream host:port that backs a
 * hosted connector in a run's scope.
 *
 * `restriction` is the enforcement half and is present only when at least one
 * connector here restricts its methods - the proxy's body-inspection path keys
 * on that alone, so an unrestricted connector adds an entry here without
 * putting its requests on any new path. `connectors` is the attribution half,
 * so a refusal the upstream answers can be reported against the connector it
 * belongs to.
 */
export interface McpHostBinding {
	/** Every hosted connector in scope whose URL is on this host:port, longest pathname first. */
	connectors: McpHostConnector[];
	restriction: McpHostRestriction | null;
}

/**
 * The key both sides of the restriction lookup agree on: lowercased hostname
 * plus the *effective* port, with the scheme default applied.
 *
 * Both halves matter. Hostname alone would let a restricted MCP server's
 * allowlist bleed onto an unrelated service on another port of the same host.
 * A raw `URL.host` would omit the port for 443/80 but include it otherwise,
 * while the proxy resolves host and port separately and always has a concrete
 * port — so the two would silently fail to match on any non-default port, and a
 * lookup that misses means *no enforcement at all*. Normalising both sides
 * through this function is what keeps that from being a silent hole.
 */
export function mcpRestrictionKey(hostname: string, port: number): string {
	return `${hostname.toLowerCase()}:${port}`;
}

/** A pathname with its trailing slash removed, the bare root staying `/`. */
function normalizeMcpPathname(pathname: string): string {
	const trimmed = pathname.replace(/\/+$/, '');
	return trimmed.length > 0 ? trimmed : '/';
}

/**
 * Build the host:port → binding map the egress proxy consults for one run:
 * every hosted connector in scope, with the method allowlist to enforce where
 * one exists.
 *
 * A host:port serving two connectors — the same provider connected twice, or a
 * project connector shadowing a global one — collapses to one entry. Their
 * enabled sets are **unioned**: the proxy cannot tell which connector a request
 * belongs to by credential shape alone, so the alternative would be blocking a
 * method one of the two connectors legitimately enables. Attribution of a
 * refusal goes by URL path instead ({@link connectorForPath}).
 */
export async function loadMcpHostBindings(
	db: Db,
	projectId?: string | null,
): Promise<Map<string, McpHostBinding>> {
	const rows = await loadConnectorsInScope(db, projectId);
	const map = new Map<string, McpHostBinding>();
	for (const row of rows) {
		if (row.kind !== ConnectorTransport.Saas) continue;
		const url = (row.config as SaasConnectorConfig)?.url;
		if (!url) continue;
		let key: string;
		let pathname: string;
		try {
			const parsed = new URL(url);
			const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
			key = mcpRestrictionKey(parsed.hostname, port);
			pathname = normalizeMcpPathname(parsed.pathname);
		} catch {
			continue;
		}
		const binding = map.get(key) ?? { connectors: [], restriction: null };
		binding.connectors.push({
			id: row.id,
			name: row.name,
			pathname,
			credentialed: row.credentialed,
		});
		if (row.enabled_methods !== null) {
			binding.restriction = binding.restriction
				? {
						connectorName: binding.restriction.connectorName,
						enabled: new Set([...binding.restriction.enabled, ...row.enabled_methods]),
					}
				: { connectorName: row.name, enabled: new Set(row.enabled_methods) };
		}
		map.set(key, binding);
	}
	for (const binding of map.values()) {
		binding.connectors.sort((a, b) => b.pathname.length - a.pathname.length);
	}
	return map;
}

/**
 * The connector a request on a bound host:port is aimed at: the one whose URL
 * pathname is the longest segment-prefix of the request path (query ignored;
 * a connector at `/` matches everything). Segment-wise, so `/mcp` never claims
 * `/mcpx`. Null when no connector's path covers the request.
 *
 * Prefix rather than equality because a legacy-SSE server hands its client a
 * server-chosen POST path beside the configured one, and a Streamable-HTTP
 * client may append to it; the handshake itself always lands on the
 * configured path.
 */
export function connectorForPath(
	binding: McpHostBinding,
	requestPath: string,
): McpHostConnector | null {
	const q = requestPath.indexOf('?');
	const path = normalizeMcpPathname(q === -1 ? requestPath : requestPath.slice(0, q));
	for (const connector of binding.connectors) {
		const prefix = connector.pathname;
		if (prefix === '/') return connector;
		if (path === prefix || path.startsWith(`${prefix}/`)) return connector;
	}
	return null;
}

/**
 * Resolve the vault secret NAME behind each connector's auth so the descriptor
 * can emit an `__HEZO_SECRET_<NAME>__` placeholder for it.
 *
 * RED LINE (AGENTS.md § Security): we deliberately NEVER decrypt here. Plaintext
 * confidential data must never enter an agent run — not its `--mcp-config`, its
 * config files, or its env. The descriptor carries only the placeholder; the
 * egress proxy substitutes the real value at request time, scoped by the
 * secret's `allowed_hosts` (auto-locked to the MCP host on connect). A call that
 * somehow bypasses the proxy just carries the unsubstituted placeholder and
 * fails upstream — a usability failure, never a leak. Because we resolve names
 * only, descriptors build fine even while the master key is locked.
 *
 * Returns two maps: OAuth-connection id → secret name, and secret id → secret
 * name (for API-key connectors that reference a `secrets` row directly).
 */
async function loadConnectorSecretNames(db: Db): Promise<{
	byOauthConnectionId: Map<string, string>;
	bySecretId: Map<string, string>;
}> {
	const byOauthConnectionId = new Map<string, string>();
	const oauth = await db.query<{ connection_id: string; secret_name: string }>(
		`SELECT oc.id AS connection_id, s.name AS secret_name
		 FROM oauth_connections oc
		 JOIN secrets s ON s.id = oc.access_token_secret_id`,
	);
	for (const row of oauth.rows) byOauthConnectionId.set(row.connection_id, row.secret_name);

	const bySecretId = new Map<string, string>();
	const apiKeys = await db.query<{ id: string; name: string }>(
		`SELECT s.id, s.name
		 FROM secrets s
		 JOIN mcp_connections mc ON mc.api_key_secret_id = s.id`,
	);
	for (const row of apiKeys.rows) bySecretId.set(row.id, row.name);

	return { byOauthConnectionId, bySecretId };
}

/**
 * Map persisted connection rows into runtime descriptors. Local MCPs whose
 * install hasn't completed are skipped with a warning so the agent run still
 * proceeds — caller can call the installer separately to (re)try.
 *
 * Connector auth is emitted as a `__HEZO_SECRET_*__` placeholder, never the raw
 * value (see {@link loadConnectorSecretNames} and the AGENTS.md red line). No
 * master key is needed at build time.
 */
export async function loadConnectorDescriptors(
	db: Db,
	projectId?: string | null,
): Promise<McpDescriptor[]> {
	const rows = await loadConnectorsForRun(db, projectId);
	const secretNames = await loadConnectorSecretNames(db);
	const descriptors: McpDescriptor[] = [];
	for (const row of rows) {
		if (row.kind === ConnectorTransport.Saas) {
			const config = row.config as SaasConnectorConfig;
			if (!config?.url) {
				log.warn('skipping saas mcp connection with no url', { id: row.id, name: row.name });
				continue;
			}
			let headers = { ...(config.headers ?? {}) };
			let host = '';
			try {
				host = new URL(config.url).host;
			} catch {
				log.warn('skipping saas mcp connection with malformed url', {
					id: row.id,
					name: row.name,
					url: config.url,
				});
				continue;
			}
			if (row.oauth_connection_id) {
				const secretName = secretNames.byOauthConnectionId.get(row.oauth_connection_id);
				if (secretName) {
					headers = stripHeader(headers, 'Authorization');
					headers.Authorization = `Bearer ${credentialPlaceholder(secretName)}`;
					log.debug('mcp descriptor built with oauth placeholder', {
						name: row.name,
						url: config.url,
						host,
						secret_name: secretName,
					});
				} else {
					log.warn('mcp connection references missing oauth secret; skipping', {
						id: row.id,
						oauth_connection_id: row.oauth_connection_id,
					});
					continue;
				}
			} else if (row.api_key_secret_id) {
				const secretName = secretNames.bySecretId.get(row.api_key_secret_id);
				if (secretName) {
					const headerName =
						config.apiKey?.header && config.apiKey.header.trim().length > 0
							? config.apiKey.header.trim()
							: 'Authorization';
					const scheme = config.apiKey?.scheme ?? 'Bearer ';
					headers = stripHeader(headers, headerName);
					headers[headerName] = `${scheme}${credentialPlaceholder(secretName)}`;
					log.debug('mcp descriptor built with api-key placeholder', {
						name: row.name,
						url: config.url,
						host,
						header: headerName,
						secret_name: secretName,
					});
				} else {
					log.warn('mcp connection references missing api-key secret; skipping', {
						id: row.id,
						api_key_secret_id: row.api_key_secret_id,
					});
					continue;
				}
			} else {
				log.debug('mcp descriptor built without connector-managed auth', {
					name: row.name,
					url: config.url,
					host,
				});
			}
			descriptors.push({
				kind: 'http',
				name: row.name,
				url: config.url,
				headers,
				...toolRestrictionOf(row),
			});
		} else if (row.kind === ConnectorTransport.Api) {
		} else if (row.kind === ConnectorTransport.Local) {
			if (row.install_status !== 'installed') {
				log.warn('skipping local mcp connection that is not installed', {
					id: row.id,
					name: row.name,
					status: row.install_status,
				});
				continue;
			}
			const config = row.config as LocalConnectorConfig;
			if (!config?.command) {
				log.warn('skipping local mcp connection with no command', { id: row.id, name: row.name });
				continue;
			}
			descriptors.push({
				kind: 'stdio',
				name: row.name,
				command: config.command,
				args: config.args,
				env: config.env,
				...toolRestrictionOf(row),
			});
		}
	}
	return descriptors;
}

/**
 * Spread-able tool-restriction fields for a descriptor. A row with no allowlist
 * yields an empty object so the keys are absent entirely and every adapter emits
 * exactly the config it emitted before method access existed — an unrestricted
 * connector must not change one byte of a run's spawn artifacts.
 *
 * `disabledTools` is the deny-list view the Claude Code adapter needs, derived
 * from the cached catalog. It is therefore only as complete as the last
 * `tools/list`; see {@link McpDescriptor.disabledTools} for why that is fine.
 */
function toolRestrictionOf(row: ConnectorRow): {
	enabledTools?: readonly string[];
	disabledTools?: readonly string[];
} {
	if (row.enabled_methods === null) return {};
	const enabled = new Set(row.enabled_methods);
	const disabled = (row.discovered_methods ?? [])
		.map((m) => m.name)
		.filter((name) => !enabled.has(name));
	return { enabledTools: row.enabled_methods, disabledTools: disabled };
}

/** Drop any case-variant of `name` from a header map (so we can set it cleanly). */
function stripHeader(headers: Record<string, string>, name: string): Record<string, string> {
	const lower = name.toLowerCase();
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(headers)) {
		if (k.toLowerCase() !== lower) out[k] = v;
	}
	return out;
}
