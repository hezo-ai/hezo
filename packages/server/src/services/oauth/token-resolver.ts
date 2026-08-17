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
	/**
	 * Set when the failure cannot be retried out of. Carries the connection's
	 * `updatedAt` at the time it was parked, so reconnecting - which moves that
	 * timestamp - un-parks it without needing an explicit hook.
	 */
	parkedAtRowVersion?: number;
}

const failures = new Map<string, RefreshFailure>();

/**
 * Whether a refresh failure can ever succeed on a retry.
 *
 * Two shapes reach this, and neither improves with time: the grant is gone, so
 * only a human reconnecting restores it; or the connection record is missing the
 * fields a refresh needs, so it was never able to refresh at all. Retrying
 * either is what produced connections sitting at 51 attempts and climbing, four
 * times an hour, forever - a fixed cost with no path to success and nothing said
 * to the operator beyond a log line.
 *
 * Matched on the message because that is what both the provider's token endpoint
 * and the generic refresh give us; `invalid_grant` is the OAuth 2.0 error code
 * for exactly this, so it is a contract rather than a phrase we invented.
 */
export function isPermanentRefreshFailure(message: string): boolean {
	return /invalid_grant|invalid_client|unauthorized_client|needs token_url \+ client_id/i.test(
		message,
	);
}

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

export interface RefreshSweepOptions {
	/**
	 * How far ahead of expiry to refresh. The egress path uses the default 60s —
	 * it runs constantly, so anything wider just adds work per request. The
	 * periodic health sweep passes a horizon wider than its own tick, so a token
	 * expiring *between* ticks is renewed before it lapses rather than after.
	 */
	horizonMs?: number;
	/**
	 * Cap on candidates per call. Required for the periodic sweep: with a wide
	 * horizon the candidate set is no longer naturally tiny, and each candidate
	 * costs a provider round-trip plus a decrypt on the process-wide DB handle.
	 */
	limit?: number;
	/** Concurrent refreshes in flight. Bounds the burst a wide horizon can cause. */
	concurrency?: number;
}

/**
 * Refresh any oauth_connections (instance-wide) expiring within the horizon.
 *
 * Two callers, deliberately configured differently. The egress proxy's
 * load-secrets path calls it before substitution so no expired token is ever
 * handed out - unbounded and narrow-horizoned, because it runs constantly and
 * the candidate set is naturally tiny. The periodic health sweep calls it with a
 * wide horizon and a limit, because on an idle instance the egress path never
 * runs at all: a token could lapse and nothing would notice until an agent run
 * happened to touch it, by which point the operator's first signal was a
 * degraded deliverable.
 *
 * Tokens without a refresh_token, or whose provider has no registered refresh
 * function, are passed through untouched (the substitution will still happen
 * with the stale token; the upstream call may fail with 401, caught upstream).
 *
 * Concurrent calls for the same connection coalesce — only one refresh
 * round-trip to the provider fires at a time. That coalescing is what makes the
 * two callers safe to overlap: for a provider that rotates refresh tokens, two
 * simultaneous refreshes would invalidate each other and kill the connection.
 */
export async function refreshExpiringTokens(
	deps: ConnectionStoreDeps,
	opts: RefreshSweepOptions = {},
): Promise<void> {
	const now = Date.now();
	const cutoff = new Date(now + (opts.horizonMs ?? REFRESH_WINDOW_MS));

	const candidates = await deps.db.query<{
		id: string;
		provider: string;
		expires_at: Date | null;
		has_refresh: boolean;
		updated_at: Date;
	}>(
		`SELECT id, provider, expires_at, updated_at,
		        refresh_token_secret_id IS NOT NULL AS has_refresh
		 FROM oauth_connections
		 WHERE expires_at IS NOT NULL
		   AND expires_at <= $1
		   AND refresh_token_secret_id IS NOT NULL
		 -- Deterministic order is load-bearing once a LIMIT exists: without it the
		 -- same arbitrary N rows can come back every tick and the rest never
		 -- refresh at all. Soonest-to-expire first is also the right priority.
		 ORDER BY expires_at ASC
		 LIMIT $2`,
		[cutoff, opts.limit ?? null],
	);

	if (candidates.rows.length === 0) return;

	const due = candidates.rows
		.filter((r) => r.has_refresh && (refreshFns.has(r.provider) || genericRefreshFn != null))
		// A connection whose last refresh failed stays out of the sweep until its
		// backoff elapses — silently, since logging every suppressed retry would
		// reproduce the flood this exists to stop.
		//
		// A parked one has an infinite backoff and only ever comes back by being
		// reconnected, which moves `updated_at`. Comparing that here is what makes
		// the park self-clearing: no hook to remember on the reconnect path, and
		// nothing to go stale if a new way to reconnect is added later.
		.filter((r) => {
			const failure = failures.get(r.id);
			if (!failure) return true;
			if (
				failure.parkedAtRowVersion !== undefined &&
				r.updated_at.getTime() !== failure.parkedAtRowVersion
			) {
				failures.delete(r.id);
				return true;
			}
			return failure.nextAttemptAt <= now;
		});

	// Chunked rather than one unbounded Promise.all: each refresh is a provider
	// round-trip plus a secret read and decrypt, and those decrypts queue behind
	// the single serialized DB handle the whole process shares.
	const concurrency = Math.max(1, opts.concurrency ?? due.length);
	for (let i = 0; i < due.length; i += concurrency) {
		await Promise.all(due.slice(i, i + concurrency).map((r) => refreshConnection(deps, r.id)));
	}
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
		const permanent = isPermanentRefreshFailure(message);
		const state = recordFailure(conn.id, Date.now());
		if (permanent) {
			// Park it rather than backing off: no number of attempts turns a revoked
			// grant or a connection missing its token endpoint into a working one.
			// Stamped with the row version so reconnecting clears this on its own.
			state.nextAttemptAt = Number.POSITIVE_INFINITY;
			state.parkedAtRowVersion = conn.updatedAt.getTime();
			log.warn('oauth token refresh cannot succeed; reconnect required', {
				id: conn.id,
				provider: conn.provider,
				error: message,
			});
		} else {
			log.warn('oauth token refresh failed', {
				id: conn.id,
				provider: conn.provider,
				error: message,
				attempts: state.attempts,
				retry_in_s: Math.round((state.nextAttemptAt - Date.now()) / 1000),
			});
		}
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

/**
 * Record (or clear) a connector's health directly by connector id.
 *
 * `auth_error` is what the derived status reads to decide a connector is
 * `degraded`, which is what lights the operator's banner - so every path that
 * discovers a credential is no longer accepted must write it, not just the token
 * refresh. Discovery probes and `test_connector` both learn this first-hand and
 * used to throw the knowledge away.
 *
 * `IS DISTINCT FROM` on both sides: under MVCC a no-op UPDATE still leaves a
 * dead tuple, and this runs on paths that can repeat every few minutes.
 */
export async function setConnectorAuthError(
	deps: ConnectionStoreDeps,
	connectorId: string,
	reason: string | null,
): Promise<void> {
	await deps.db.query(
		`UPDATE mcp_connections SET auth_error = $1, updated_at = now()
		 WHERE id = $2 AND auth_error IS DISTINCT FROM $1`,
		[reason, connectorId],
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
