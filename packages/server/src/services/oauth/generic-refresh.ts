import { refreshAccessToken } from './provider-generic';
import { type GenericRefreshFn, loadSecretValue, registerGenericRefreshFn } from './token-resolver';

/**
 * Provider-agnostic host-side refresh: reads token_url + client_id off the
 * connection's metadata and decrypts the optional client_secret from the vault,
 * then runs the refresh_token grant. Registered once at startup as the fallback
 * for any oauth_connection whose provider has no bespoke refresh fn — so a new
 * device-flow provider needs zero refresh code.
 */
export const genericRefreshFn: GenericRefreshFn = async (deps, conn, refreshToken) => {
	const tokenUrl = typeof conn.metadata.token_url === 'string' ? conn.metadata.token_url : null;
	const clientId = typeof conn.metadata.client_id === 'string' ? conn.metadata.client_id : null;
	if (!tokenUrl || !clientId) {
		throw new Error('generic refresh needs token_url + client_id in connection metadata');
	}
	let clientSecret: string | undefined;
	if (conn.clientSecretSecretId) {
		clientSecret = (await loadSecretValue(deps, conn.clientSecretSecretId)) ?? undefined;
	}
	const t = await refreshAccessToken({ tokenUrl, clientId, clientSecret, refreshToken });
	return {
		accessToken: t.accessToken,
		refreshToken: t.refreshToken ?? null,
		expiresAt: t.expiresAt ?? null,
	};
};

export function registerGenericOAuthRefresh(): void {
	registerGenericRefreshFn(genericRefreshFn);
}
