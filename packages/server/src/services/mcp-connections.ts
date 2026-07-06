import { McpConnectionKind, type McpInstallStatus } from '@hezo/shared';
import type { MasterKeyManager } from '../crypto/master-key';
import type { Db } from '../db/database';
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
	// to want OAuth but haven't completed it (no oauth_connection_id and any of:
	// agent-requested via the connector flow, discovery already persisted
	// config.dcr, or an OAuth attempt recorded auth_error) — injecting those
	// would just 401 on every run. Operator-created rows that never attempted
	// OAuth carry none of these markers and continue to be included regardless
	// (existing behavior for public / header-authenticated MCPs).
	const scopeClause = projectId != null ? `AND (project_id = $1 OR project_id IS NULL)` : '';
	const params = projectId != null ? [projectId] : [];
	const result = await db.query<McpConnectionRow>(
		`SELECT id, name, kind::text AS kind,
		        config, oauth_connection_id, install_status::text AS install_status, install_error,
		        created_at::text, updated_at::text
		 FROM mcp_connections
		 WHERE revoked_at IS NULL
		   AND NOT (kind = 'saas' AND oauth_connection_id IS NULL
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
 * Build a lookup map oauthConnectionId → {secretName, decryptedAccessToken}.
 * We materialize the token at descriptor-build time and emit it directly in
 * the MCP descriptor's Authorization header rather than relying on an
 * egress-proxy placeholder substitution: Claude Code (and similar adapters)
 * make their MCP-startup HTTP calls through an `undici` client whose
 * `EnvHttpProxyAgent` activation we can't always guarantee in CI/container
 * environments. The AI-adapter API key follows the same materialize-at-launch
 * carve-out (see services/agent-runner.ts:buildProviderEnv); the run-scoped
 * container is ephemeral, the vault remains the long-term store, and each
 * run materializes a fresh value (so revocation still cascades on next run).
 */
async function loadAllOAuthSecrets(
	db: Db,
	masterKeyManager: MasterKeyManager,
): Promise<Map<string, { secretName: string; accessToken: string | null }>> {
	const out = new Map<string, { secretName: string; accessToken: string | null }>();
	const key = masterKeyManager.getKey();
	const result = await db.query<{
		connection_id: string;
		secret_name: string;
		encrypted_value: string;
	}>(
		`SELECT oc.id AS connection_id, s.name AS secret_name, s.encrypted_value
		 FROM oauth_connections oc
		 JOIN secrets s ON s.id = oc.access_token_secret_id`,
	);
	if (!key) {
		// Master key locked: log per-row and emit no token. Caller falls through
		// to placeholder mode (which is also broken in this state, but at least
		// the descriptor is still built so the failure mode is "401 from upstream"
		// rather than "MCP missing from config entirely").
		for (const row of result.rows) {
			out.set(row.connection_id, { secretName: row.secret_name, accessToken: null });
		}
		return out;
	}
	const { decrypt } = await import('../crypto/encryption');
	for (const row of result.rows) {
		let accessToken: string | null = null;
		try {
			accessToken = decrypt(row.encrypted_value, key);
		} catch (e) {
			log.warn('could not decrypt oauth access token; descriptor will use placeholder', {
				connection_id: row.connection_id,
				error: (e as Error).message,
			});
		}
		out.set(row.connection_id, { secretName: row.secret_name, accessToken });
	}
	return out;
}

/**
 * Map persisted connection rows into runtime descriptors. Local MCPs whose
 * install hasn't completed are skipped with a warning so the agent run still
 * proceeds — caller can call the installer separately to (re)try.
 */
export async function loadMcpConnectionDescriptors(
	db: Db,
	masterKeyManager: MasterKeyManager,
	projectId?: string | null,
): Promise<McpDescriptor[]> {
	const rows = await loadMcpConnectionsForRun(db, projectId);
	const oauthSecrets = await loadAllOAuthSecrets(db, masterKeyManager);
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
				const entry = oauthSecrets.get(row.oauth_connection_id);
				if (entry && entry.accessToken) {
					headers = stripExistingAuth(headers);
					headers.Authorization = `Bearer ${entry.accessToken}`;
					log.debug('mcp descriptor built with materialized oauth token', {
						name: row.name,
						url: config.url,
						host,
						secret_name: entry.secretName,
						token_prefix: entry.accessToken.slice(0, 8),
						token_length: entry.accessToken.length,
					});
				} else {
					log.warn('mcp connection references missing oauth secret; skipping', {
						id: row.id,
						oauth_connection_id: row.oauth_connection_id,
						secret_name: entry?.secretName,
					});
					continue;
				}
			} else {
				log.debug('mcp descriptor built without oauth (no oauth_connection_id)', {
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

function stripExistingAuth(headers: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(headers)) {
		if (k.toLowerCase() !== 'authorization') out[k] = v;
	}
	return out;
}
