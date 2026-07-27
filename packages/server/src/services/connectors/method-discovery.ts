/**
 * Lists the methods (tools) a connected MCP server advertises, classifies each
 * as read-only or write, and caches the result on the connector row so an
 * operator can pick which ones agents may call.
 *
 * This runs in the **server** process, not in an agent run, and it is the one
 * place in the connector code that decrypts a connector's credential. That is
 * deliberate and permitted: the AGENTS.md red line governs what may enter an
 * agent run (its env, config, args, logs), and trusted server code decrypting a
 * vault secret in-process is the same mechanism the chat-channel bot tokens and
 * the `test_connector` tool already use. The decrypted token lives only in this
 * function's locals for the duration of one `tools/list` round trip.
 *
 * It must never be called from `loadConnectorDescriptors` — that path resolves
 * secret *names* only so descriptors still build while the master key is locked.
 */

import {
	ConnectorTransport,
	classifyMcpMethods,
	type McpMethodInfo,
	readOnlyMethodNames,
} from '@hezo/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Db } from '../../db/database';
import { logger } from '../../logger';
import { loadSecretValue } from '../oauth/token-resolver';
import type { SaasConnectorConfig } from './connections';

const log = logger.child('connector-methods');

/** How long a discovery probe may take before we give up on the server. */
const DISCOVERY_TIMEOUT_MS = 20_000;

export interface MethodDiscoveryDeps {
	db: Db;
	masterKeyManager: MasterKeyManager;
}

/**
 * Why a discovery attempt produced no catalog. These are surfaced to the
 * operator on the connector card, so each one has to say something they can act
 * on rather than collapsing into a generic failure.
 */
export type MethodDiscoveryFailure =
	/** The connector row is gone. */
	| 'not_found'
	/** Not an MCP server — an `api` connector has no methods, and a `local`
	 *  (stdio) server runs inside the project container, not somewhere the server
	 *  process can reach. */
	| 'unsupported_kind'
	/** The connector has not completed auth, so a probe would just 401. */
	| 'not_connected'
	/** The instance is locked, so the credential can't be decrypted. Transient:
	 *  discovery works again after an unlock, and the refresh button retries. */
	| 'locked'
	/** The server refused, timed out, or spoke something other than MCP. */
	| 'probe_failed';

export type MethodDiscoveryResult =
	| { ok: true; methods: McpMethodInfo[]; appliedReadOnly: boolean }
	| { ok: false; reason: MethodDiscoveryFailure; detail?: string };

interface DiscoveryRow {
	id: string;
	name: string;
	kind: string;
	config: SaasConnectorConfig;
	oauth_connection_id: string | null;
	api_key_secret_id: string | null;
	activated_at: string | null;
	revoked_at: string | null;
	requested_access: string | null;
	access_applied_at: string | null;
	enabled_methods: string[] | null;
}

/**
 * Resolve the real auth headers for a server-side probe. Mirrors the header
 * shape `loadConnectorDescriptors` builds for a run, except the values are the
 * decrypted secrets rather than `__HEZO_SECRET_*__` placeholders — the egress
 * proxy that would substitute them is not in this path.
 */
async function buildProbeHeaders(
	deps: MethodDiscoveryDeps,
	row: DiscoveryRow,
): Promise<{ ok: true; headers: Record<string, string> } | { ok: false; reason: 'locked' }> {
	const headers: Record<string, string> = { ...(row.config.headers ?? {}) };

	// Static headers can themselves carry placeholders (an operator-configured
	// `__HEZO_SECRET_X__`). We cannot substitute those here, and sending one
	// verbatim would authenticate as the literal string — drop them so the probe
	// either succeeds unauthenticated or fails cleanly, rather than looking like
	// a credential failure the operator can't explain.
	for (const [k, v] of Object.entries(headers)) {
		if (/__HEZO_SECRET_[A-Z0-9_]+__/.test(v)) delete headers[k];
	}

	if (row.oauth_connection_id) {
		const secretId = await deps.db.query<{ access_token_secret_id: string }>(
			`SELECT access_token_secret_id FROM oauth_connections WHERE id = $1`,
			[row.oauth_connection_id],
		);
		const id = secretId.rows[0]?.access_token_secret_id;
		if (id) {
			const token = await loadSecretValue(deps, id);
			if (token === null) return { ok: false, reason: 'locked' };
			headers.Authorization = `Bearer ${token}`;
		}
	} else if (row.api_key_secret_id) {
		const key = await loadSecretValue(deps, row.api_key_secret_id);
		if (key === null) return { ok: false, reason: 'locked' };
		const headerName = row.config.apiKey?.header?.trim() || 'Authorization';
		const scheme = row.config.apiKey?.scheme ?? 'Bearer ';
		headers[headerName] = `${scheme}${key}`;
	}

	return { ok: true, headers };
}

/**
 * Open an MCP session and list its tools. Tries Streamable HTTP first (what
 * every current MCP server speaks) and falls back to SSE for older ones, since
 * the transport is not recorded on the row.
 */
async function listRemoteTools(
	url: string,
	headers: Record<string, string>,
): Promise<{ name: string; description?: string; annotations?: { readOnlyHint?: boolean } }[]> {
	const attempt = async (transport: Transport) => {
		const client = new Client({ name: 'hezo-connector-discovery', version: '1.0.0' });
		try {
			await client.connect(transport);
			const result = await client.listTools(undefined, { timeout: DISCOVERY_TIMEOUT_MS });
			return result.tools;
		} finally {
			// Always tear the session down — a leaked SSE connection would hold a
			// socket open on the server for the life of the process.
			await client.close().catch(() => {});
		}
	};

	const target = new URL(url);
	try {
		return await attempt(new StreamableHTTPClientTransport(target, { requestInit: { headers } }));
	} catch (streamableError) {
		try {
			return await attempt(new SSEClientTransport(target, { requestInit: { headers } }));
		} catch {
			// Report the Streamable-HTTP failure: it is the transport essentially
			// every current server speaks, so its error is the one that explains
			// what actually went wrong.
			throw streamableError;
		}
	}
}

/**
 * Discover, classify and persist a connector's methods.
 *
 * When the connector carries an unapplied `access: 'read'` request from the
 * agent that registered it, this is where that request takes effect — once. The
 * update is guarded on `access_applied_at IS NULL AND enabled_methods IS NULL`,
 * so a later refresh never re-narrows a list an operator has since widened, and
 * a re-registration never overrides an operator's decision.
 */
export async function discoverConnectorMethods(
	deps: MethodDiscoveryDeps,
	connectorId: string,
	/**
	 * What prompted this attempt, which decides how loudly a failure is logged.
	 * `connect` fires opportunistically after every activation, including for
	 * servers that are perfectly usable but answer no `tools/list` — a failure
	 * there is ordinary and already visible on the connector card, so it logs at
	 * debug. `manual` means an operator pressed refresh and is waiting on an
	 * answer, so a failure is worth a warning.
	 */
	trigger: 'connect' | 'manual' = 'manual',
): Promise<MethodDiscoveryResult> {
	const found = await deps.db.query<DiscoveryRow>(
		`SELECT id, name, kind::text AS kind, config, oauth_connection_id, api_key_secret_id,
		        activated_at::text AS activated_at, revoked_at::text AS revoked_at,
		        requested_access::text AS requested_access,
		        access_applied_at::text AS access_applied_at,
		        enabled_methods
		 FROM mcp_connections WHERE id = $1`,
		[connectorId],
	);
	const row = found.rows[0];
	if (!row) return { ok: false, reason: 'not_found' };

	if (row.kind !== ConnectorTransport.Saas) return { ok: false, reason: 'unsupported_kind' };
	if (!row.config?.url) return { ok: false, reason: 'unsupported_kind' };
	if (row.revoked_at) return { ok: false, reason: 'not_connected' };

	// A server that needs auth and hasn't got it will 401 on every probe. Rows
	// with neither auth link are public / statically-header-authenticated MCPs,
	// which are probeable as-is.
	const needsAuth = !!(row.oauth_connection_id || row.api_key_secret_id);
	if (needsAuth && !row.activated_at) return { ok: false, reason: 'not_connected' };

	const built = await buildProbeHeaders(deps, row);
	if (!built.ok) return { ok: false, reason: built.reason };

	let tools: Awaited<ReturnType<typeof listRemoteTools>>;
	try {
		tools = await listRemoteTools(row.config.url, built.headers);
	} catch (e) {
		const detail = (e as Error).message;
		const at = trigger === 'manual' ? log.warn : log.debug;
		at.call(log, 'mcp method discovery failed', { connectorId, name: row.name, error: detail });
		return { ok: false, reason: 'probe_failed', detail };
	}

	const methods = classifyMcpMethods(tools);

	// Apply a pending read-only request in the same statement that stores the
	// catalog, so there is no window where the methods are known but the
	// requested restriction has not been applied.
	const applyReadOnly =
		row.requested_access === 'read' && !row.access_applied_at && row.enabled_methods === null;

	if (applyReadOnly) {
		await deps.db.query(
			`UPDATE mcp_connections
			 SET discovered_methods = $1::jsonb,
			     methods_listed_at = now(),
			     enabled_methods = $2::jsonb,
			     access_applied_at = now(),
			     updated_at = now()
			 WHERE id = $3 AND access_applied_at IS NULL AND enabled_methods IS NULL`,
			[JSON.stringify(methods), JSON.stringify(readOnlyMethodNames(methods)), connectorId],
		);
	} else {
		await deps.db.query(
			`UPDATE mcp_connections
			 SET discovered_methods = $1::jsonb, methods_listed_at = now(), updated_at = now()
			 WHERE id = $2`,
			[JSON.stringify(methods), connectorId],
		);
	}

	log.info('mcp methods discovered', {
		connectorId,
		name: row.name,
		total: methods.length,
		read_only: methods.filter((m) => m.readOnly).length,
		applied_read_only: applyReadOnly,
	});

	return { ok: true, methods, appliedReadOnly: applyReadOnly };
}
