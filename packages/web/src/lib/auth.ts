import {
	type AuthKeyPair,
	buildLoginMessage,
	buildPasswordLoginMessage,
	buildPasswordSetupMessage,
	buildSetupMessage,
	buildUnlockMessage,
	deriveAuthKeyPair,
	derivePasswordKeyPair,
	deriveUnlockKey,
	generatePasswordSalt,
	type LocaleSettings,
	type MasterKeyState,
	signAuthMessage,
} from '@hezo/shared';
import { ApiError, api } from './api';
import { clearPendingSsoHandle, goToIssuer } from './sso';

export interface StatusResponse {
	/** Absent while the server is still booting (`starting` is true). */
	masterKeyState?: MasterKeyState;
	/** True once the admin has enrolled a password verifier (gate: login vs create-password). */
	passwordSet?: boolean;
	version: string;
	/** True when the server is still booting; the rest of the app should wait. */
	starting?: boolean;
	/** Coarse boot phase id (e.g. `migrations`, `workspace`) — for the loading screen. */
	phase?: string;
	/** Human-readable phase message, safe to show in the UI. */
	message?: string;
	/** Optional extra context for the loading screen. */
	detail?: string;
	/**
	 * The instance display locale. Public because every pre-auth screen (the
	 * language step, the master-key gate, the login form) renders in it before
	 * any credential exists. Absent while the server is booting — no database is
	 * open yet — so callers fall back to their stored render hint.
	 */
	locale?: LocaleSettings;
	/**
	 * Whether the operator has ever chosen a locale. Drives the onboarding
	 * language gate; distinct from "the locale equals the default", which an
	 * operator may legitimately have picked.
	 */
	localeConfigured?: boolean;
	/**
	 * Why the PREVIOUS boot died, when it died fatally. Present only while
	 * `starting` — a restart loop repeats the same failure, so this is what turns
	 * an endless boot screen into something actionable.
	 */
	lastFailure?: StartupFailure;
	/**
	 * Where to sign in, when an external issuer is configured. Absent on an
	 * instance that has none, which is what makes the gate's decision a presence
	 * check rather than a flag it has to trust.
	 */
	sso?: { issuer_url: string; logout_url: string };
}

/** Mirrors `StartupFailureRecord` in `packages/server/src/startup-failure.ts`. */
export interface StartupFailure {
	message: string;
	phase: string;
	version: string;
	at: string;
}

/** The password below is the minimum the UI will accept before deriving a verifier. */
export const MIN_PASSWORD_LENGTH = 8;

// The mnemonic flows return a short-lived, password-setup-scoped token — NOT a
// session. It's held in memory (never persisted) until the create-password step
// exchanges it for a real session via `setPassword`.
let pendingSetupToken: string | null = null;
export function getPendingSetupToken(): string | null {
	return pendingSetupToken;
}
export function clearPendingSetupToken(): void {
	pendingSetupToken = null;
}

export async function checkStatus(): Promise<StatusResponse> {
	const res = await fetch('/api/status');
	const body = (await res.json()) as StatusResponse & {
		error?: { code?: string; message?: string };
		last_failure?: StartupFailure;
	};
	// While booting, the server answers 200 with `starting: true` and a live phase
	// instead of `masterKeyState`. Surface it so the UI can render a loading screen.
	if (body.starting) {
		return {
			starting: true,
			phase: body.phase,
			message: body.message,
			detail: body.detail,
			version: body.version,
			lastFailure: body.last_failure,
		};
	}
	if (!res.ok) {
		const msg = body.error?.message ?? res.statusText;
		throw new Error(msg || `Status request failed (${res.status})`);
	}
	if (!body.masterKeyState) {
		throw new Error('Invalid status response from server');
	}
	return body;
}

/**
 * Authenticate with the 12-word master key phrase. The phrase never leaves the
 * browser: it derives an Ed25519 keypair (whose signature over a server
 * challenge proves ownership) and an unlock key. A new process starts locked by
 * default. Signed web setup or unlock sends the key, a supervised update can
 * carry it through an in-memory IPC handoff, and deliberate one-shot
 * `--master-key` or `HEZO_MASTER_KEY` input derives it for direct startup
 * injection.
 *
 * The master key only *unlocks* — it does not mint a session. The server returns
 * a short-lived, password-setup-scoped token, held in memory here; the caller
 * then routes to the create-password step, which exchanges it for a session.
 */
export async function authenticateWithMnemonic(
	phrase: string,
	state: MasterKeyState,
): Promise<void> {
	const keys = deriveAuthKeyPair(phrase);
	const unlockKey = deriveUnlockKey(phrase);

	if (state === 'unset') {
		const data = await api.post<{ token: string }>('/api/auth/setup', {
			public_key: keys.publicKeyHex,
			unlock_key: unlockKey,
			signature: signAuthMessage(keys.privateKey, buildSetupMessage(keys.publicKeyHex, unlockKey)),
		});
		pendingSetupToken = data.token;
		return;
	}

	try {
		await challengeLogin(keys, state === 'locked' ? unlockKey : null);
	} catch (err) {
		// The server restarted (and locked) between the status fetch and this
		// attempt — retry once with the unlock key included.
		if ((err as ApiError).code === 'UNLOCK_KEY_REQUIRED') {
			await challengeLogin(keys, unlockKey);
			return;
		}
		throw err;
	}
}

async function challengeLogin(keys: AuthKeyPair, unlockKey: string | null): Promise<void> {
	const challenge = await api.post<{ challenge_id: string; nonce: string }>('/api/auth/challenge');
	const body: Record<string, string> = { challenge_id: challenge.challenge_id };
	if (unlockKey !== null) {
		body.unlock_key = unlockKey;
		body.signature = signAuthMessage(
			keys.privateKey,
			buildUnlockMessage(challenge.nonce, unlockKey),
		);
	} else {
		body.signature = signAuthMessage(keys.privateKey, buildLoginMessage(challenge.nonce));
	}
	const data = await api.post<{ token: string }>('/api/auth/verify', body);
	pendingSetupToken = data.token;
}

/**
 * Log in with the admin password via challenge-response. The password never
 * leaves the browser: it derives an Ed25519 keypair from `scrypt(password, salt)`
 * and signs a one-time server nonce. On success a session JWT is stored.
 */
export async function loginWithPassword(password: string): Promise<void> {
	const challenge = await api.post<{ challenge_id: string; nonce: string; salt: string }>(
		'/api/auth/password-challenge',
	);
	const { privateKey } = await derivePasswordKeyPair(password, challenge.salt);
	const data = await api.post<{ token: string }>('/api/auth/password-verify', {
		challenge_id: challenge.challenge_id,
		signature: signAuthMessage(privateKey, buildPasswordLoginMessage(challenge.nonce)),
	});
	api.setToken(data.token);
	clearPendingSetupToken();
}

/**
 * Set or change the admin password. Derives a fresh verifier `{ salt, public_key }`
 * plus a self-signature (the password itself is never sent) and enrolls it,
 * authenticating with the current session if logged in, otherwise the in-memory
 * password-setup token from the mnemonic flow. Returns having stored the session.
 */
export async function setPassword(password: string): Promise<void> {
	const salt = generatePasswordSalt();
	const { publicKeyHex, privateKey } = await derivePasswordKeyPair(password, salt);
	const signature = signAuthMessage(privateKey, buildPasswordSetupMessage(publicKeyHex, salt));

	const bearer = api.getToken() ?? pendingSetupToken;
	const res = await fetch('/api/auth/password', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
		},
		body: JSON.stringify({ salt, public_key: publicKeyHex, signature }),
	});
	const json = (await res.json().catch(() => null)) as {
		data?: { token: string };
		error?: { code?: string; message?: string };
	} | null;
	if (!res.ok) {
		throw new ApiError(
			json?.error?.code ?? 'UNKNOWN',
			json?.error?.message ?? res.statusText,
			res.status,
		);
	}
	if (json?.data?.token) api.setToken(json.data.token);
	clearPendingSetupToken();
}

/**
 * Change the admin password while signed in. Proves the CURRENT password by
 * signing a fresh server challenge with the keypair derived from it (the server
 * verifies against the stored verifier and throttles like login), then enrolls
 * a fresh verifier for the new password. Neither password leaves the browser.
 * The server returns a rotated session, so the user stays signed in.
 */
export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
	const challenge = await api.post<{ challenge_id: string; nonce: string; salt: string }>(
		'/api/auth/password-challenge',
	);
	const current = await derivePasswordKeyPair(currentPassword, challenge.salt);
	const currentSignature = signAuthMessage(
		current.privateKey,
		buildPasswordLoginMessage(challenge.nonce),
	);

	const salt = generatePasswordSalt();
	const { publicKeyHex, privateKey } = await derivePasswordKeyPair(newPassword, salt);
	const signature = signAuthMessage(privateKey, buildPasswordSetupMessage(publicKeyHex, salt));

	const data = await api.post<{ token: string }>('/api/auth/password', {
		salt,
		public_key: publicKeyHex,
		signature,
		current_challenge_id: challenge.challenge_id,
		current_signature: currentSignature,
	});
	api.setToken(data.token);
}

/**
 * End the session.
 *
 * With an issuer, clearing the local token is not enough: the issuer still has
 * a session of its own and would sign the person straight back in on the next
 * redirect, so signing out looks like nothing happened. Handing the browser to
 * the issuer's logout is what actually ends it.
 *
 * This ends a session; it does not re-lock the instance. A new process starts
 * locked by default, though a supervised update may restore the key through its
 * in-memory IPC handoff and deliberate one-shot `--master-key` or
 * `HEZO_MASTER_KEY` input may inject it at startup.
 */
export function logout(issuerLogoutUrl?: string) {
	api.clearToken();
	clearPendingSetupToken();
	// Survives only because the redirect below unloads the page, which is not a
	// reason to leave it holding a verified identity.
	clearPendingSsoHandle();
	if (issuerLogoutUrl) goToIssuer(issuerLogoutUrl);
}

export function isAuthenticated(): boolean {
	return api.getToken() !== null;
}
