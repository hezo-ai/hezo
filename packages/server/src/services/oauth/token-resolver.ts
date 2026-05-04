import { logger } from '../../logger';
import {
	type ConnectionStoreDeps,
	getConnection,
	type OAuthConnectionRow,
	updateTokens,
} from './connection-store';

const log = logger.child('oauth-token-resolver');

const REFRESH_WINDOW_MS = 60_000;

export interface RefreshResult {
	accessToken: string;
	refreshToken?: string | null;
	expiresAt?: Date | null;
}

export type RefreshFn = (
	connection: OAuthConnectionRow,
	currentRefreshToken: string,
) => Promise<RefreshResult>;

const refreshFns = new Map<string, RefreshFn>();
const inflight = new Map<string, Promise<void>>();

export function registerRefreshFn(provider: string, fn: RefreshFn): void {
	refreshFns.set(provider, fn);
}

export function clearRefreshFns(): void {
	refreshFns.clear();
}

/**
 * Refresh any oauth_connections in this company that are expiring within
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
export async function refreshExpiringTokensForCompany(
	deps: ConnectionStoreDeps,
	companyId: string,
): Promise<void> {
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
		 WHERE company_id = $1
		   AND expires_at IS NOT NULL
		   AND expires_at <= $2
		   AND refresh_token_secret_id IS NOT NULL`,
		[companyId, cutoff],
	);

	if (candidates.rows.length === 0) return;

	await Promise.all(
		candidates.rows
			.filter((r) => r.has_refresh && refreshFns.has(r.provider))
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
	const refreshFn = refreshFns.get(conn.provider);
	if (!refreshFn) {
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
		const result = await refreshFn(conn, refreshTokenValue);
		await updateTokens(deps, {
			connectionId: conn.id,
			accessToken: result.accessToken,
			refreshToken: result.refreshToken ?? null,
			expiresAt: result.expiresAt ?? null,
		});
		log.info('oauth token refreshed', { id: conn.id, provider: conn.provider });
	} catch (e) {
		log.warn('oauth token refresh failed', {
			id: conn.id,
			provider: conn.provider,
			error: (e as Error).message,
		});
	}
}

async function loadSecretValue(
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
