/**
 * Probes a hosted MCP server: opens a session, lists the tools it advertises,
 * classifies each as read-only or write, and records both the catalog and the
 * evidence that the server answered at all.
 *
 * That evidence is what decides whether an uncredentialed connector reaches an
 * agent run. A hosted server with no OAuth connection and no stored API key is
 * either genuinely public or quietly demanding auth, and the difference is only
 * knowable by asking it. This function is the one place that asks, and the one
 * writer of `probed_at` / `probe_error`.
 *
 * This runs in the **server** process, not in an agent run, and it is the one
 * place in the connector code that decrypts a connector's credential. That is
 * deliberate and permitted: the AGENTS.md red line governs what may enter an
 * agent run (its env, config, args, logs), and trusted server code decrypting a
 * vault secret in-process is the same mechanism the chat-channel bot tokens and
 * the `test_connector` tool already use. The decrypted token lives only in this
 * function's locals for the duration of one probe.
 *
 * It must never be called from `loadConnectorDescriptors` — that path resolves
 * secret *names* only so descriptors still build while the master key is locked.
 */

import {
	ConnectorProbeError,
	ConnectorTransport,
	classifyMcpMethods,
	containsCredentialPlaceholder,
	MCP_TOOL_NAME_MAX_LENGTH,
	type McpMethodInfo,
	qualifiedMcpToolName,
	readOnlyMethodNames,
} from '@hezo/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Db } from '../../db/database';
import { logger } from '../../logger';
import { loadSecretValue, refreshConnection, setConnectorAuthError } from '../oauth/token-resolver';
import { SAAS_CREDENTIALED_SQL, type SaasConnectorConfig } from './connections';

const log = logger.child('connector-methods');

/** How long a whole probe may take before we give up on the server. */
const DISCOVERY_TIMEOUT_MS = 20_000;

/**
 * How close to expiry a token must be before a probe renews it first. Matches
 * the egress path's own refresh window - a token outside it is fine to probe
 * with, and refreshing anyway costs a provider round-trip for nothing.
 */
const PROBE_REFRESH_WINDOW_MS = 60_000;

export interface MethodDiscoveryDeps {
	db: Db;
	masterKeyManager: MasterKeyManager;
}

/**
 * How far a probe got. The distinction is the whole point of recording probe
 * evidence: `initialize` is what an agent's MCP client has to complete, while a
 * tool catalog is optional. A server that serves only prompts or resources
 * answers the handshake and refuses `tools/list`, so treating a catalog failure
 * as "this server does not work" would exclude a class of usable servers.
 */
export type ProbePhase = 'handshake' | 'catalog';

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
	/** The server rejected our credential (401/403). Distinct from `probe_failed`
	 *  because the remedy is specific and human-only - reconnect the connector -
	 *  and because the raw transport error for this case is actively unhelpful:
	 *  the MCP SDK reports it as "Error POSTing to endpoint:" with the upstream's
	 *  (usually empty) body appended, which says nothing about the token. */
	| 'auth_failed'
	/** The server rejected the probe, but the probe could not carry the
	 *  connector's own credential: its auth rides a `__HEZO_SECRET_*__` header
	 *  the egress proxy substitutes at request time, and nothing on this side can
	 *  reproduce that. The refusal is therefore not evidence about the connector
	 *  in either direction, and nothing about its health is recorded. */
	| 'auth_unverifiable'
	/** The server refused, timed out, or spoke something other than MCP. */
	| 'probe_failed';

export type MethodDiscoveryResult =
	| { ok: true; methods: McpMethodInfo[]; appliedReadOnly: boolean }
	| { ok: false; reason: MethodDiscoveryFailure; detail?: string; phase?: ProbePhase };

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

/** The headers a probe will send, plus whether it had to leave one behind. */
interface ProbeHeaders {
	ok: true;
	headers: Record<string, string>;
	/**
	 * True when the row carries a `__HEZO_SECRET_*__` header this probe could not
	 * substitute. The probe then goes out with less than a run would carry, so its
	 * answer says nothing about the connector's credential.
	 */
	strippedPlaceholder: boolean;
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
): Promise<ProbeHeaders | { ok: false; reason: 'locked' }> {
	const headers: Record<string, string> = { ...(row.config.headers ?? {}) };

	// Static headers can themselves carry placeholders (an operator-configured
	// `__HEZO_SECRET_X__`). We cannot substitute those here, and sending one
	// verbatim would authenticate as the literal string — drop them so the probe
	// either succeeds unauthenticated or fails cleanly, rather than looking like
	// a credential failure the operator can't explain. Whether one was dropped is
	// carried out of here, because a probe missing a credential must not be
	// allowed to write a verdict about that credential.
	let strippedPlaceholder = false;
	for (const [k, v] of Object.entries(headers)) {
		if (containsCredentialPlaceholder(v)) {
			delete headers[k];
			strippedPlaceholder = true;
		}
	}

	if (row.oauth_connection_id) {
		const conn = await deps.db.query<{
			access_token_secret_id: string;
			needs_refresh: boolean;
		}>(
			`SELECT access_token_secret_id,
			        (expires_at IS NOT NULL
			         AND expires_at <= now() + ($2 || ' milliseconds')::interval
			         AND refresh_token_secret_id IS NOT NULL) AS needs_refresh
			 FROM oauth_connections WHERE id = $1`,
			[row.oauth_connection_id, String(PROBE_REFRESH_WINDOW_MS)],
		);
		// Renew an expiring token before probing, so the manual "Refresh methods"
		// button stops failing against a token that was merely stale but perfectly
		// renewable. Gated on expiry, NOT unconditional: `refreshConnection` does
		// no expiry check of its own, so calling it every probe would burn a
		// provider round-trip per click and - against a provider that rotates
		// refresh tokens - rotate the grant each time. Its `inflight` dedup is what
		// keeps this safe alongside a concurrent health sweep.
		if (conn.rows[0]?.needs_refresh) {
			await refreshConnection(deps, row.oauth_connection_id).catch(() => {
				// A failed refresh is already recorded on the connector by the
				// resolver. Fall through and probe anyway: the token may still be
				// valid (the failure could be the provider's token endpoint rather
				// than the grant), and the probe's own 401 handling gives the
				// operator a better message than the refresh error would.
			});
		}
		const id = conn.rows[0]?.access_token_secret_id;
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

	return { ok: true, headers, strippedPlaceholder };
}

interface RemoteTool {
	name: string;
	description?: string;
	annotations?: { readOnlyHint?: boolean };
}

type ProbeOutcome =
	| { ok: true; tools: RemoteTool[] }
	| { ok: false; phase: ProbePhase; error: unknown };

/**
 * Bind an outer deadline onto every request a transport makes.
 *
 * The SDK builds each request's `RequestInit` itself and sets `signal` from its
 * own per-transport controller *after* spreading the caller's `requestInit`, so
 * a signal handed in that way is silently discarded. The `fetch` override is
 * the one injection point every call site in both transports goes through, so
 * combining the signals here is what actually makes the deadline hold - and a
 * deadline is what makes this safe to run from a cron, where one hung server
 * would otherwise wedge every later tick.
 */
function deadlineBoundFetch(deadline: AbortSignal): FetchLike {
	return (input, init) =>
		fetch(input, {
			...init,
			signal: init?.signal ? AbortSignal.any([deadline, init.signal]) : deadline,
		});
}

/**
 * Open an MCP session and list its tools, reporting how far it got. Tries
 * Streamable HTTP first (what every current MCP server speaks) and falls back
 * to SSE for older ones, since the transport is not recorded on the row.
 */
async function probeRemoteServer(
	url: string,
	headers: Record<string, string>,
	deadline: AbortSignal,
): Promise<ProbeOutcome> {
	const attempt = async (transport: Transport): Promise<ProbeOutcome> => {
		const client = new Client({ name: 'hezo-connector-discovery', version: '1.0.0' });
		try {
			try {
				await client.connect(transport);
			} catch (error) {
				return { ok: false, phase: 'handshake', error };
			}
			try {
				const result = await client.listTools(undefined, { timeout: DISCOVERY_TIMEOUT_MS });
				return { ok: true, tools: result.tools };
			} catch (error) {
				return { ok: false, phase: 'catalog', error };
			}
		} finally {
			// Always tear the session down — a leaked SSE connection would hold a
			// socket open on the server for the life of the process.
			await client.close().catch(() => {});
		}
	};

	const target = new URL(url);
	const requestInit = { headers, signal: deadline };
	const fetchWithDeadline = deadlineBoundFetch(deadline);
	const streamable = await attempt(
		new StreamableHTTPClientTransport(target, { requestInit, fetch: fetchWithDeadline }),
	);
	// A completed handshake settles the question the fallback exists to answer:
	// this server speaks Streamable HTTP. Retrying over SSE could only replace a
	// known-good handshake with a second transport's failure.
	if (streamable.ok || streamable.phase === 'catalog') return streamable;

	// A refusal is the same refusal at the same URL over either transport, and
	// not asking twice halves what we send a provider that has already said no.
	const streamableStatus = httpStatusOf(streamable.error);
	if (streamableStatus === 401 || streamableStatus === 403) return streamable;

	const sse = await attempt(
		new SSEClientTransport(target, { requestInit, fetch: fetchWithDeadline }),
	);
	if (sse.ok || sse.phase === 'catalog') return sse;
	// Report the Streamable-HTTP failure: it is the transport essentially every
	// current server speaks, so its error is the one that explains what actually
	// went wrong. The one exception is when only the SSE attempt carries an HTTP
	// status - that status is the difference between "your token is dead" and an
	// opaque transport string, so prefer whichever error can be classified.
	if (streamableStatus === null && httpStatusOf(sse.error) !== null) return sse;
	return streamable;
}

/**
 * The HTTP status behind an MCP SDK transport error, when there is one.
 *
 * The SDK's `StreamableHTTPError` carries the status on `code` and renders a
 * message of the form `Streamable HTTP error: Error POSTing to endpoint: <body>`
 * - so when the upstream answers 401 with an empty body (which is what an
 * expired OAuth grant looks like), the message ends at a bare colon and tells
 * the operator nothing. The status is the only usable signal, and reading
 * `(e as Error).message` threw it away.
 */
function httpStatusOf(e: unknown): number | null {
	const code = (e as { code?: unknown })?.code;
	if (typeof code === 'number' && code >= 100 && code < 600) return code;
	// Some transports surface it as `response.status` instead.
	const status = (e as { response?: { status?: unknown } })?.response?.status;
	if (typeof status === 'number') return status;
	return null;
}

/**
 * Stamp the probe evidence. Written on every attempt that got as far as
 * contacting the server, and only those: a row skipped for being locked, gone,
 * or the wrong kind was never measured, and stamping it would let those cases
 * burn the sweep's pacing clock and pass a connector off as proven.
 */
async function recordProbe(
	deps: MethodDiscoveryDeps,
	connectorId: string,
	error: ConnectorProbeError | null,
): Promise<void> {
	await deps.db
		.query(
			`UPDATE mcp_connections
			 SET probed_at = now(), probe_error = $1::connector_probe_error, updated_at = now()
			 WHERE id = $2`,
			[error, connectorId],
		)
		.catch((e) =>
			log.debug('could not record connector probe evidence', { error: (e as Error).message }),
		);
}

/**
 * Discover, classify and persist a connector's methods, and record whether the
 * server answered Hezo at all.
 *
 * Two rules govern what is written, and they are deliberately different:
 *
 * - **`auth_error` is written only when the probe carried every credential a
 *   run would carry.** A probe that had to drop a placeholder header went out
 *   with less than a run does, so neither its refusal nor its success says
 *   anything about the connector's credential, in either direction.
 * - **`probe_error` is written on every attempt that reached the server**,
 *   including one that could not carry a credential. It records what happened
 *   to *this* probe, which is exactly what the run gate and the sweep's pacing
 *   need.
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
	 * `manual` means an operator pressed refresh and is waiting on an answer, so a
	 * failure is worth a warning. Everything else fires on Hezo's own schedule -
	 * after an activation, at registration, on the health sweep, or after an
	 * agent run's request to the connector was refused (`run`) - where a failure
	 * is ordinary, already visible on the connector card or in the run's log, and
	 * logs at debug.
	 */
	trigger: 'connect' | 'create' | 'sweep' | 'manual' | 'run' = 'manual',
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

	// A credential that cannot be assembled - unreadable ciphertext, a refresh that
	// throws - fails the probe rather than the caller. `add_connector` awaits this
	// on a write that has already succeeded, and a diagnostic must not turn a
	// registered connector into a failed tool call. No evidence is stamped either
	// way: the server was never reached, so there is nothing to record about it,
	// and the health sweep retries.
	let built: Awaited<ReturnType<typeof buildProbeHeaders>>;
	try {
		built = await buildProbeHeaders(deps, row);
	} catch (e) {
		log.debug('mcp probe could not assemble credentials', {
			connectorId,
			error: (e as Error).message,
		});
		return { ok: false, reason: 'probe_failed', detail: (e as Error).message };
	}
	if (!built.ok) return { ok: false, reason: built.reason };

	// Whether this probe is entitled to an opinion on the connector's credential.
	// It needs one to judge (a stored token or key) and must have carried every
	// one the row has.
	const canJudgeCredential = needsAuth && !built.strippedPlaceholder;

	const deadline = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
	const outcome = await probeRemoteServer(row.config.url, built.headers, deadline);

	if (!outcome.ok) {
		const detail = (outcome.error as Error)?.message ?? String(outcome.error);
		const status = httpStatusOf(outcome.error);
		const rejectedCredential = status === 401 || status === 403;
		const at = trigger === 'manual' ? log.warn : log.debug;
		at.call(log, 'mcp method discovery failed', {
			connectorId,
			name: row.name,
			phase: outcome.phase,
			status,
			error: detail,
		});

		// The handshake completed, so the server is reachable and speaks MCP -
		// which is the evidence a run needs. Only the tool catalog is missing, and
		// a server serving prompts or resources alone is entitled to refuse it.
		if (outcome.phase === 'catalog') {
			await recordProbe(deps, connectorId, null);
			if (rejectedCredential && canJudgeCredential) {
				await setConnectorAuthError(deps, connectorId, `probe: HTTP ${status}`).catch((err) =>
					log.debug('could not record connector auth error', { error: (err as Error).message }),
				);
			}
			return { ok: false, reason: 'probe_failed', detail, phase: 'catalog' };
		}

		if (rejectedCredential) {
			// The probe went out with less than a run would send, so the refusal is
			// about the probe, not the connector. Recording it would permanently
			// exclude a connector that works perfectly well once the egress proxy
			// substitutes its header.
			if (built.strippedPlaceholder) {
				await recordProbe(deps, connectorId, null);
				return {
					ok: false,
					reason: 'auth_unverifiable',
					detail: `HTTP ${status}`,
					phase: 'handshake',
				};
			}
			await recordProbe(deps, connectorId, ConnectorProbeError.AuthRequired);
			// A rejected credential is connector health, not a transient probe error:
			// record it so the operator's banner lights up and the card offers a
			// reconnect, rather than the knowledge dying in this one toast.
			if (canJudgeCredential) {
				await setConnectorAuthError(deps, connectorId, `probe: HTTP ${status}`).catch((err) =>
					log.debug('could not record connector auth error', { error: (err as Error).message }),
				);
			}
			return { ok: false, reason: 'auth_failed', detail: `HTTP ${status}`, phase: 'handshake' };
		}

		await recordProbe(deps, connectorId, ConnectorProbeError.Unreachable);
		return { ok: false, reason: 'probe_failed', detail, phase: 'handshake' };
	}

	await recordProbe(deps, connectorId, null);

	const methods = classifyMcpMethods(outcome.tools);

	// Warned here, once per catalog refresh, rather than on every descriptor
	// build: the condition is a property of the connector's name plus the server's
	// tool names, so repeating it per run would be noise on a green log without
	// telling an operator anything new. Not fatal - what an over-long name costs
	// is decided upstream by the provider, so the run still gets the descriptor.
	const overLong = methods
		.map((m) => qualifiedMcpToolName(row.name, m.name))
		.filter((n) => n.length > MCP_TOOL_NAME_MAX_LENGTH);
	if (overLong.length > 0) {
		log.warn('connector tool names exceed the provider tool-name limit', {
			connectorId,
			name: row.name,
			limit: MCP_TOOL_NAME_MAX_LENGTH,
			count: overLong.length,
			examples: overLong.slice(0, 3),
		});
	}

	// Apply a pending read-only request in the same statement that stores the
	// catalog, so there is no window where the methods are known but the
	// requested restriction has not been applied.
	const readOnlyNames = readOnlyMethodNames(methods);
	const wantsReadOnly =
		row.requested_access === 'read' && !row.access_applied_at && row.enabled_methods === null;
	// An allowlist that enables nothing is never what `access: 'read'` asked for -
	// it means the classifier recognised no read method at all, which a server
	// that names every tool after itself can produce for its whole catalog.
	// Applying it would withhold every tool while the connector still reports
	// Connected, so leave it unrestricted and make the miss visible instead.
	const applyReadOnly = wantsReadOnly && readOnlyNames.length > 0;
	if (wantsReadOnly && readOnlyNames.length === 0 && methods.length > 0) {
		log.warn('connector read-access request not applied: no method classified read-only', {
			connectorId,
			name: row.name,
			methodCount: methods.length,
		});
	}

	if (applyReadOnly) {
		await deps.db.query(
			`UPDATE mcp_connections
			 SET discovered_methods = $1::jsonb,
			     methods_listed_at = now(),
			     enabled_methods = $2::jsonb,
			     access_applied_at = now(),
			     updated_at = now()
			 WHERE id = $3 AND access_applied_at IS NULL AND enabled_methods IS NULL`,
			[JSON.stringify(methods), JSON.stringify(readOnlyNames), connectorId],
		);
	} else {
		await deps.db.query(
			`UPDATE mcp_connections
			 SET discovered_methods = $1::jsonb, methods_listed_at = now(), updated_at = now()
			 WHERE id = $2`,
			[JSON.stringify(methods), connectorId],
		);
	}

	// The probe just authenticated successfully, which is direct evidence the
	// stored credential works - so a stale `auth_error` from an earlier failure
	// must not keep the connector reading as degraded (and the banner lit). Only
	// when the probe actually carried that credential: a success reached without
	// it says nothing about it.
	if (canJudgeCredential) {
		await setConnectorAuthError(deps, connectorId, null).catch((err) =>
			log.debug('could not clear connector auth error', { error: (err as Error).message }),
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

/** Turn a discovery failure into something an operator can act on. */
export function describeDiscoveryFailure(result: { reason: string; detail?: string }): string {
	switch (result.reason) {
		case 'unsupported_kind':
			return 'Method access applies to hosted MCP servers only.';
		case 'not_connected':
			return 'Connect this server before listing its methods.';
		case 'locked':
			return 'Hezo is locked, so this connector’s credential can’t be read. Unlock and try again.';
		case 'not_found':
			return 'connector not found';
		case 'auth_failed':
			// The case that used to surface as a bare "Error POSTing to endpoint:" -
			// complete, but useless, because an expired grant answers 401 with an
			// empty body and the SDK puts the body last. Say what actually happened.
			return `This server rejected Hezo's credential (${result.detail ?? 'unauthorized'}). Its authorization has expired or been revoked - reconnect the connector, then list its methods again.`;
		case 'auth_unverifiable':
			return `This server wants a credential (${result.detail ?? 'unauthorized'}) and this connector's own credential rides a placeholder header the egress proxy substitutes at request time, which Hezo can't reproduce here. Agent runs still get it; nothing about its health has been recorded.`;
		default:
			return `The server did not answer: ${result.detail ?? 'unknown error'}`;
	}
}

/** What a probe found, in the shape the create surfaces hand back. */
export interface ConnectorProbeVerdict {
	/** Whether the server completed the MCP handshake for Hezo's probe. */
	reachable: boolean;
	/**
	 * What was recorded: `ok`, one of the {@link ConnectorProbeError} values, or
	 * `unverifiable` when this connector's own credential could not be carried.
	 * `null` when nothing was probed at all.
	 */
	probe: 'ok' | 'unverifiable' | ConnectorProbeError | null;
	note: string;
}

/**
 * Say what a probe means for the connector's reach, for the surfaces that
 * register one and probe it in the same call. Kept next to the probe so the
 * wording cannot drift from the outcomes it describes.
 */
export function describeProbeVerdict(result: MethodDiscoveryResult): ConnectorProbeVerdict {
	if (result.ok) {
		return {
			reachable: true,
			probe: 'ok',
			note: 'This server completed the MCP handshake, so it reaches agent runs.',
		};
	}
	if (result.reason === 'probe_failed' && result.phase === 'catalog') {
		return {
			reachable: true,
			probe: 'ok',
			note: 'This server completed the MCP handshake but served no tool catalog, so it reaches agent runs and may expose prompts or resources rather than tools.',
		};
	}
	if (result.reason === 'auth_unverifiable') {
		return {
			reachable: false,
			probe: 'unverifiable',
			note: "This server wants a credential, and this connector's own credential is a placeholder the egress proxy substitutes at request time, which Hezo can't reproduce from here. It still reaches agent runs.",
		};
	}
	if (result.reason === 'auth_failed') {
		return {
			reachable: false,
			probe: ConnectorProbeError.AuthRequired,
			note: 'This server wants a credential Hezo does not have, so it stays out of agent runs. Connect it or attach an API key on the Connectors page.',
		};
	}
	if (result.reason === 'probe_failed') {
		return {
			reachable: false,
			probe: ConnectorProbeError.Unreachable,
			note: `This server did not answer (${result.detail ?? 'unknown error'}), so it stays out of agent runs until a later check reaches it.`,
		};
	}
	return { reachable: false, probe: null, note: describeDiscoveryFailure(result) };
}

/** Pacing and batching for one pass of the probe sweep. */
export interface ConnectorProbeSweepOptions {
	/** Most connectors to probe in one tick. */
	limit: number;
	/** How old a probe must be before it is re-run. */
	staleAfterMs: number;
	/** How many probes run at once. */
	concurrency: number;
}

/**
 * Re-prove the uncredentialed hosted connectors, oldest evidence first.
 *
 * These are the rows nothing else watches: the token sweep reads
 * `oauth_connections`, so a connector with no connection is invisible to it,
 * and until this ran an unprovable row was handed to every agent run forever.
 * Selection matches `idx_mcp_connections_probe_due` so the scan is the index.
 *
 * Placeholder-header rows are excluded rather than probed: their credential is
 * substituted by the egress proxy, so a probe from here could only ever record
 * a refusal that says nothing, and they reach runs on that basis anyway.
 *
 * Nothing here decrypts, so it runs whether or not the instance is unlocked.
 */
export async function probeUnverifiedConnectors(
	deps: MethodDiscoveryDeps,
	opts: ConnectorProbeSweepOptions,
): Promise<{ probed: number }> {
	const due = await deps.db.query<{ id: string; name: string }>(
		`SELECT id, name FROM mcp_connections
		 WHERE kind = 'saas'
		   AND revoked_at IS NULL
		   AND oauth_connection_id IS NULL
		   AND api_key_secret_id IS NULL
		   AND NOT ${SAAS_CREDENTIALED_SQL}
		   AND (probed_at IS NULL OR probed_at <= now() - ($1 || ' milliseconds')::interval)
		 ORDER BY probed_at ASC NULLS FIRST, created_at ASC
		 LIMIT $2`,
		[String(opts.staleAfterMs), opts.limit],
	);
	if (due.rows.length === 0) return { probed: 0 };

	// Chunked rather than one unbounded Promise.all: each probe is a third-party
	// round trip plus two writes, and those writes queue behind the single
	// serialized DB handle the whole process shares.
	const concurrency = Math.max(1, opts.concurrency);
	for (let i = 0; i < due.rows.length; i += concurrency) {
		await Promise.all(
			due.rows.slice(i, i + concurrency).map((r) =>
				discoverConnectorMethods(deps, r.id, 'sweep').catch((e) =>
					log.debug('connector probe failed', {
						connectorId: r.id,
						name: r.name,
						error: (e as Error).message,
					}),
				),
			),
		);
	}
	log.debug('connector probe sweep complete', { probed: due.rows.length });
	return { probed: due.rows.length };
}
