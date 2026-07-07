import { McpConnectionKind, type McpInstallStatus } from '@hezo/shared';
import type { Db } from '../db/database';
import { credentialPlaceholder } from '../lib/credential-placeholder';
import { logger } from '../logger';
import type { McpDescriptor } from './mcp-injectors';

const log = logger.child('mcp-connections');

export interface SaasMcpConfig {
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

export interface LocalMcpConfig {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	package?: string;
}

export type McpConnectionConfig = SaasMcpConfig | LocalMcpConfig;

export interface McpConnectionRow {
	id: string;
	name: string;
	kind: McpConnectionKind;
	config: McpConnectionConfig;
	oauth_connection_id: string | null;
	api_key_secret_id: string | null;
	install_status: McpInstallStatus;
	install_error: string | null;
	created_at: string;
	updated_at: string;
}

/**
 * Load MCP connections exposed to an agent run. Scoped to the run's project: its
 * own connectors plus global ("all projects") ones. When a project and a global
 * connector share a name, the project's own wins (it shadows the global) — the
 * `ORDER BY … (project_id IS NULL) DESC` emits globals first so the last-write
 * Map keeps the project row.
 */
export async function loadMcpConnectionsForRun(
	db: Db,
	projectId?: string | null,
): Promise<McpConnectionRow[]> {
	// Filters: skip revoked (user disconnected); skip saas rows that are known
	// to want auth but haven't completed it — no oauth_connection_id AND no
	// api_key_secret_id, plus any of: agent-requested via the connector flow,
	// discovery already persisted config.dcr, or an auth attempt recorded
	// auth_error. Injecting those would just 401 on every run. A connector that
	// HAS completed auth (either an OAuth connection or a pasted API key) is
	// always included. Operator-created rows that never attempted auth carry none
	// of these markers and continue to be included regardless (existing behavior
	// for public / header-authenticated MCPs).
	const scopeClause = projectId != null ? `AND (project_id = $1 OR project_id IS NULL)` : '';
	const params = projectId != null ? [projectId] : [];
	const result = await db.query<McpConnectionRow>(
		`SELECT id, name, kind::text AS kind,
		        config, oauth_connection_id, api_key_secret_id,
		        install_status::text AS install_status, install_error,
		        created_at::text, updated_at::text
		 FROM mcp_connections
		 WHERE revoked_at IS NULL
		   AND NOT (kind = 'saas' AND oauth_connection_id IS NULL AND api_key_secret_id IS NULL
		            AND (created_by_task_id IS NOT NULL
		                 OR config ? 'dcr'
		                 OR auth_error IS NOT NULL))
		   ${scopeClause}
		 ORDER BY name ASC, (project_id IS NULL) DESC`,
		params,
	);

	const out = new Map<string, McpConnectionRow>();
	for (const row of result.rows) out.set(row.name, row);
	return [...out.values()];
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
export async function loadMcpConnectionDescriptors(
	db: Db,
	projectId?: string | null,
): Promise<McpDescriptor[]> {
	const rows = await loadMcpConnectionsForRun(db, projectId);
	const secretNames = await loadConnectorSecretNames(db);
	const descriptors: McpDescriptor[] = [];
	for (const row of rows) {
		if (row.kind === McpConnectionKind.Saas) {
			const config = row.config as SaasMcpConfig;
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
			});
		} else if (row.kind === McpConnectionKind.Local) {
			if (row.install_status !== 'installed') {
				log.warn('skipping local mcp connection that is not installed', {
					id: row.id,
					name: row.name,
					status: row.install_status,
				});
				continue;
			}
			const config = row.config as LocalMcpConfig;
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
			});
		}
	}
	return descriptors;
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
