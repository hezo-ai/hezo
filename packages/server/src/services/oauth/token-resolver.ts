import { logger } from '../../logger';
import {
	type ConnectionStoreDeps,
	getConnection,
	type OAuthConnectionRow,
	updateTokens,
} from './connection-store';

const log = logger.child('oauth-token-resolver');

const REFRESH_WINDOW_MS = 60_000;

/**
 * Backoff for a connection whose refresh keeps failing. The sweep runs from the
 * egress substitution path on *every* proxied request carrying a placeholder —
 * i.e. every MCP call — and a failed refresh never advances `expires_at`, so a
 * permanently broken connection would otherwise be retried hundreds of times a
 * minute, flooding the log and hammering the provider's token endpoint. Doubling
 * from 30s to a 15min ceiling keeps a transient failure recovering quickly while
 * a structurally broken one settles to four attempts an hour.
 */
const REFRESH_BACKOFF_BASE_MS = 30_000;
const REFRESH_BACKOFF_MAX_MS = 15 * 60_000;

interface RefreshFailure {
	attempts: number;
	nextAttemptAt: number;
}

const failures = new Map<string, RefreshFailure>();

function backoffDelay(attempts: number): number {
	return Math.min(REFRESH_BACKOFF_BASE_MS * 2 ** (attempts - 1), REFRESH_BACKOFF_MAX_MS);
}

/** Record a failed attempt and return the resulting backoff state. */
function recordFailure(connectionId: string, now: number): RefreshFailure {
	const attempts = (failures.get(connectionId)?.attempts ?? 0) + 1;
	const next = { attempts, nextAttemptAt: now + backoffDelay(attempts) };
	failures.set(connectionId, next);
	return next;
}

export interface RefreshResult {
	accessToken: string;
	refreshToken?: string | null;
	expiresAt?: Date | null;
}

export type RefreshFn = (
	connection: OAuthConnectionRow,
	currentRefreshToken: string,
) => Promise<RefreshResult>;

/**
 * Provider-agnostic fallback refresh: unlike {@link RefreshFn} it receives the
 * store `deps` so it can decrypt host-only material (the client secret) and read
 * the token endpoint / client id off the connection's own metadata. Registered
 * once at startup; used for any connection whose provider has no bespoke fn.
 */
export type GenericRefreshFn = (
	deps: ConnectionStoreDeps,
	connection: OAuthConnectionRow,
	currentRefreshToken: string,
) => Promise<RefreshResult>;

const refreshFns = new Map<string, RefreshFn>();
let genericRefreshFn: GenericRefreshFn | null = null;
const inflight = new Map<string, Promise<void>>();

export function registerRefreshFn(provider: string, fn: RefreshFn): void {
	refreshFns.set(provider, fn);
}

export function registerGenericRefreshFn(fn: GenericRefreshFn): void {
	genericRefreshFn = fn;
}

export function clearRefreshFns(): void {
	refreshFns.clear();
	genericRefreshFn = null;
	failures.clear();
}

/**
 * Refresh any oauth_connections (instance-wide) that are expiring within
 * `REFRESH_WINDOW_MS`. Called from the egress proxy's load-secrets path
 * before substitution so that no expired token is ever handed out.
 *
 * Tokens without a refresh_token, or whose provider has no registered
 * refresh function, are passed through untouched (the substitution will
 * still happen with the stale token; the upstream call may fail with 401,
 * which is caught upstream).
 *
 * Concurrent calls for the same connection coalesce — only one refresh
 * round-trip to the provider fires at a time.
 */
export async function refreshExpiringTokens(deps: ConnectionStoreDeps): Promise<void> {
	const now = Date.now();
	const cutoff = new Date(now + REFRESH_WINDOW_MS);

	const candidates = await deps.db.query<{
		id: string;
		provider: string;
		expires_at: Date | null;
		has_refresh: boolean;
	}>(
		`SELECT id, provider, expires_at, refresh_token_secret_id IS NOT NULL AS has_refresh
		 FROM oauth_connections
		 WHERE expires_at IS NOT NULL
		   AND expires_at <= $1
		   AND refresh_token_secret_id IS NOT NULL`,
		[cutoff],
	);

	if (candidates.rows.length === 0) return;

	await Promise.all(
		candidates.rows
			.filter((r) => r.has_refresh && (refreshFns.has(r.provider) || genericRefreshFn != null))
			// A connection whose last refresh failed stays out of the sweep until its
			// backoff elapses — silently, since logging every suppressed retry would
			// reproduce the flood this exists to stop.
			.filter((r) => (failures.get(r.id)?.nextAttemptAt ?? 0) <= now)
			.map((r) => refreshConnection(deps, r.id)),
	);
}

export async function refreshConnection(
	deps: ConnectionStoreDeps,
	connectionId: string,
): Promise<void> {
	const existing = inflight.get(connectionId);
	if (existing) return existing;

	const promise = doRefresh(deps, connectionId).finally(() => inflight.delete(connectionId));
	inflight.set(connectionId, promise);
	return promise;
}

async function doRefresh(deps: ConnectionStoreDeps, connectionId: string): Promise<void> {
	const conn = await getConnection(deps, connectionId);
	if (!conn) {
		log.warn('refresh skipped — connection not found', { id: connectionId });
		return;
	}
	const providerFn = refreshFns.get(conn.provider);
	if (!providerFn && !genericRefreshFn) {
		log.debug('refresh skipped — no provider fn', { provider: conn.provider });
		return;
	}
	if (!conn.refreshTokenSecretId) {
		log.debug('refresh skipped — no refresh token', { id: conn.id });
		return;
	}

	const refreshTokenValue = await loadSecretValue(deps, conn.refreshTokenSecretId);
	if (!refreshTokenValue) {
		log.warn('refresh skipped — could not decrypt refresh token', { id: conn.id });
		return;
	}

	try {
		// A provider-specific fn wins over the generic fallback; the generic fn
		// reads token_url + client_id off the connection metadata (and decrypts the
		// optional client secret) so a new device-flow provider needs no bespoke code.
		let result: RefreshResult;
		if (providerFn) result = await providerFn(conn, refreshTokenValue);
		else if (genericRefreshFn) result = await genericRefreshFn(deps, conn, refreshTokenValue);
		else {
			log.debug('refresh skipped — no provider fn', { provider: conn.provider });
			return;
		}
		await updateTokens(deps, {
			connectionId: conn.id,
			accessToken: result.accessToken,
			refreshToken: result.refreshToken ?? null,
			expiresAt: result.expiresAt ?? null,
		});
		failures.delete(conn.id);
		// Best-effort, and outside the refresh's own success/failure accounting: a
		// bookkeeping error here must not be reported as a failed refresh.
		await clearConnectorAuthError(deps, conn.id).catch((err) =>
			log.debug('could not clear connector auth error', { error: (err as Error).message }),
		);
		log.info('oauth token refreshed', { id: conn.id, provider: conn.provider });
	} catch (e) {
		const message = (e as Error).message;
		const state = recordFailure(conn.id, Date.now());
		log.warn('oauth token refresh failed', {
			id: conn.id,
			provider: conn.provider,
			error: message,
			attempts: state.attempts,
			retry_in_s: Math.round((state.nextAttemptAt - Date.now()) / 1000),
		});
		// Record it on the connector too, so a stale token is visible on the
		// Connectors page instead of only in the log. Best-effort: a failure here
		// must not mask the refresh failure we are already reporting.
		await recordConnectorAuthError(deps, conn.id, `token refresh: ${message}`).catch((err) =>
			log.debug('could not record connector auth error', { error: (err as Error).message }),
		);
	}
}

/**
 * Mirror a refresh failure onto the MCP connector backed by this connection.
 * Keyed on `oauth_connection_id`, so a connection with no connector (a repo or
 * broker-only connection) is a harmless no-op and no cross-service import is
 * needed.
 */
async function recordConnectorAuthError(
	deps: ConnectionStoreDeps,
	connectionId: string,
	reason: string,
): Promise<void> {
	await deps.db.query(
		`UPDATE mcp_connections SET auth_error = $1, updated_at = now()
		 WHERE oauth_connection_id = $2 AND auth_error IS DISTINCT FROM $1`,
		[reason, connectionId],
	);
}

async function clearConnectorAuthError(
	deps: ConnectionStoreDeps,
	connectionId: string,
): Promise<void> {
	await deps.db.query(
		`UPDATE mcp_connections SET auth_error = NULL, updated_at = now()
		 WHERE oauth_connection_id = $1 AND auth_error IS NOT NULL`,
		[connectionId],
	);
}

export async function loadSecretValue(
	deps: ConnectionStoreDeps,
	secretId: string,
): Promise<string | null> {
	const key = deps.masterKeyManager.getKey();
	if (!key) return null;
	const result = await deps.db.query<{ encrypted_value: string }>(
		`SELECT encrypted_value FROM secrets WHERE id = $1`,
		[secretId],
	);
	if (result.rows.length === 0) return null;
	const { decrypt } = await import('../../crypto/encryption');
	return decrypt(result.rows[0].encrypted_value, key);
}
