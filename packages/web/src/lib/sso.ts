import { api } from './api';

/**
 * Signing in through an external issuer.
 *
 * The issuer proves *who* is signing in and nothing else. It never sees the
 * recovery phrase, and an instance that accepts its token is still locked, so
 * the flow has two halves that can be minutes apart: the token arrives and is
 * verified now, and the session is minted after the phrase is entered.
 *
 * What survives that gap is a handle, held **in memory only** - never in
 * storage, never in a URL. Closing the tab loses it, which is correct: it is
 * proof that an identity was asserted a moment ago, not a credential to keep.
 */

const FRAGMENT_PREFIX = '#sso=';

let pendingHandle: string | null = null;

/**
 * Take the token out of the URL fragment, if one is there.
 *
 * A fragment rather than a query string because fragments are never sent to a
 * server, so the token stays out of access logs and referrer headers on the way
 * in. It is stripped from the address bar immediately either way, so a copied
 * URL or a back-navigation cannot carry it.
 */
export function hasSsoTokenInFragment(): boolean {
	return window.location.hash.startsWith(FRAGMENT_PREFIX);
}

export function takeSsoTokenFromFragment(): string | null {
	const hash = window.location.hash;
	if (!hash.startsWith(FRAGMENT_PREFIX)) return null;
	const token = decodeURIComponent(hash.slice(FRAGMENT_PREFIX.length));
	window.history.replaceState(null, '', window.location.pathname + window.location.search);
	return token.length > 0 ? token : null;
}

export type SsoOutcome = 'signed-in' | 'locked';

/**
 * Present a token. Answers whether it produced a session, or a handle waiting on
 * the instance to be unlocked.
 */
export async function submitSsoToken(token: string): Promise<SsoOutcome> {
	const data = await api.post<{ locked: boolean; token?: string; handle?: string }>(
		'/api/auth/sso',
		{ token },
	);
	if (data.locked) {
		pendingHandle = data.handle ?? null;
		return 'locked';
	}
	if (data.token) api.setToken(data.token);
	return 'signed-in';
}

export function hasPendingSsoHandle(): boolean {
	return pendingHandle !== null;
}

export function clearPendingSsoHandle(): void {
	pendingHandle = null;
}

/**
 * Redeem the held handle for a session, once the instance is unlocked. Single
 * use on both sides: the handle is dropped here whether or not it worked, so a
 * failure falls through to the ordinary sign-in rather than retrying forever.
 */
export async function redeemPendingSsoHandle(): Promise<boolean> {
	const handle = pendingHandle;
	pendingHandle = null;
	if (!handle) return false;
	const data = await api.post<{ token: string }>('/api/auth/sso/session', { handle });
	api.setToken(data.token);
	return true;
}

/** Send the browser to the issuer to be identified. */
export function goToIssuer(issuerUrl: string): void {
	window.location.assign(issuerUrl);
}
