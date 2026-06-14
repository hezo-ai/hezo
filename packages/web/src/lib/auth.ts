import {
	type AuthKeyPair,
	buildLoginMessage,
	buildSetupMessage,
	buildUnlockMessage,
	deriveAuthKeyPair,
	deriveUnlockKey,
	type MasterKeyState,
	signAuthMessage,
} from '@hezo/shared';
import { type ApiError, api } from './api';

interface StatusResponse {
	masterKeyState: MasterKeyState;
	version: string;
}

export async function checkStatus(): Promise<StatusResponse> {
	const res = await fetch('/api/status');
	const body = (await res.json()) as StatusResponse & {
		error?: { code?: string; message?: string };
	};
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
 * Authenticate with the 12-word master key phrase. The phrase never leaves
 * the browser: it derives an Ed25519 keypair (whose signature over a server
 * challenge is the login credential) and an unlock key (transmitted only at
 * setup and unlock-after-restart, inside the signed payload, to root the
 * server's at-rest encryption).
 */
export async function authenticateWithMnemonic(
	phrase: string,
	state: MasterKeyState,
): Promise<string> {
	const keys = deriveAuthKeyPair(phrase);
	const unlockKey = deriveUnlockKey(phrase);

	if (state === 'unset') {
		const data = await api.post<{ token: string }>('/api/auth/setup', {
			public_key: keys.publicKeyHex,
			unlock_key: unlockKey,
			signature: signAuthMessage(keys.privateKey, buildSetupMessage(keys.publicKeyHex, unlockKey)),
		});
		api.setToken(data.token);
		return data.token;
	}

	try {
		return await challengeLogin(keys, state === 'locked' ? unlockKey : null);
	} catch (err) {
		// The server restarted (and locked) between the status fetch and this
		// attempt — retry once with the unlock key included.
		if ((err as ApiError).code === 'UNLOCK_KEY_REQUIRED') {
			return await challengeLogin(keys, unlockKey);
		}
		throw err;
	}
}

async function challengeLogin(keys: AuthKeyPair, unlockKey: string | null): Promise<string> {
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
	api.setToken(data.token);
	return data.token;
}

export function logout() {
	api.clearToken();
}

export function isAuthenticated(): boolean {
	return api.getToken() !== null;
}
