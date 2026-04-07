import { createHmac, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { deriveKey } from './encryption';
import type { MasterKeyManager } from './master-key';

export interface StatePayload {
	callback_url: string;
	platform: string;
	nonce: string;
	timestamp: string;
	original_state?: string;
}

export interface OAuthStatePayload {
	company_id: string;
	ai_provider?: string;
}

/**
 * Verify an Ed25519-signed state from Hezo Connect.
 */
export function verifyConnectState(signedState: string, publicKeyPem: string): StatePayload | null {
	const dotIndex = signedState.lastIndexOf('.');
	if (dotIndex === -1) return null;

	const encoded = signedState.substring(0, dotIndex);
	const signature = signedState.substring(dotIndex + 1);

	try {
		const key = createPublicKey(publicKeyPem);
		const valid = verify(null, Buffer.from(encoded), key, Buffer.from(signature, 'base64url'));
		if (!valid) return null;

		const json = Buffer.from(encoded, 'base64url').toString('utf8');
		return JSON.parse(json) as StatePayload;
	} catch {
		return null;
	}
}

/**
 * Sign a server-originated OAuth state containing company_id.
 */
export async function signOAuthState(
	payload: OAuthStatePayload,
	masterKeyManager: MasterKeyManager,
): Promise<string> {
	const masterKeyHex = masterKeyManager.getMasterKeyHex();
	if (!masterKeyHex) throw new Error('Master key not available');
	const key = await deriveKey(masterKeyHex, 'oauth-state');
	const json = JSON.stringify(payload);
	const encoded = Buffer.from(json).toString('base64url');
	const signature = createHmac('sha256', key).update(encoded).digest('base64url');
	return `${encoded}.${signature}`;
}

/**
 * Verify a server-originated OAuth state.
 */
export async function verifyOAuthState(
	signedState: string,
	masterKeyManager: MasterKeyManager,
): Promise<OAuthStatePayload | null> {
	const dotIndex = signedState.lastIndexOf('.');
	if (dotIndex === -1) return null;

	const encoded = signedState.substring(0, dotIndex);
	const signature = signedState.substring(dotIndex + 1);

	try {
		const masterKeyHex = masterKeyManager.getMasterKeyHex();
		if (!masterKeyHex) return null;
		const key = await deriveKey(masterKeyHex, 'oauth-state');
		const expected = createHmac('sha256', key).update(encoded).digest('base64url');

		if (signature.length !== expected.length) return null;
		if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;

		const json = Buffer.from(encoded, 'base64url').toString('utf8');
		return JSON.parse(json) as OAuthStatePayload;
	} catch {
		return null;
	}
}
