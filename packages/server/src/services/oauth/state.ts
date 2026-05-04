import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { deriveKey } from '../../crypto/encryption';
import type { MasterKeyManager } from '../../crypto/master-key';

const STATE_PURPOSE = 'oauth_state';
const STATE_TTL_MS = 15 * 60 * 1000;

export interface ManualOAuthConfig {
	authorize_url: string;
	token_url: string;
	client_id: string;
	client_secret?: string;
	scopes: string[];
}

export interface StatePayload {
	companyId: string;
	provider: string;
	nonce: string;
	codeVerifier: string;
	redirectUri: string;
	returnTo: string;
	expiresAt: number;
	mcpConnectionId?: string;
	mcpConnectionName?: string;
	manualConfig?: ManualOAuthConfig;
	resourceUrl?: string;
}

export interface NewStateInput {
	companyId: string;
	provider: string;
	redirectUri: string;
	returnTo: string;
	mcpConnectionId?: string;
	mcpConnectionName?: string;
	manualConfig?: ManualOAuthConfig;
	resourceUrl?: string;
}

export async function signState(
	masterKeyManager: MasterKeyManager,
	input: NewStateInput,
): Promise<{ state: string; codeVerifier: string; codeChallenge: string }> {
	const masterHex = masterKeyManager.getMasterKeyHex();
	if (!masterHex) throw new Error('master key not unlocked');

	const codeVerifier = base64url(randomBytes(32));
	const codeChallenge = base64url(await sha256(codeVerifier));

	const payload: StatePayload = {
		companyId: input.companyId,
		provider: input.provider,
		nonce: randomBytes(16).toString('hex'),
		codeVerifier,
		redirectUri: input.redirectUri,
		returnTo: input.returnTo,
		expiresAt: Date.now() + STATE_TTL_MS,
		mcpConnectionId: input.mcpConnectionId,
		mcpConnectionName: input.mcpConnectionName,
		manualConfig: input.manualConfig,
		resourceUrl: input.resourceUrl,
	};

	const payloadB64 = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
	const sig = await hmac(masterHex, payloadB64);
	const state = `${payloadB64}.${base64url(sig)}`;

	return { state, codeVerifier, codeChallenge };
}

export async function verifyState(
	masterKeyManager: MasterKeyManager,
	state: string,
): Promise<StatePayload | null> {
	const masterHex = masterKeyManager.getMasterKeyHex();
	if (!masterHex) return null;

	const [payloadB64, sigB64] = state.split('.');
	if (!payloadB64 || !sigB64) return null;

	const expectedSig = await hmac(masterHex, payloadB64);
	const providedSig = base64urlDecode(sigB64);
	if (expectedSig.length !== providedSig.length) return null;
	if (!timingSafeEqual(expectedSig, providedSig)) return null;

	let payload: StatePayload;
	try {
		payload = JSON.parse(base64urlDecode(payloadB64).toString('utf8')) as StatePayload;
	} catch {
		return null;
	}
	if (payload.expiresAt < Date.now()) return null;
	return payload;
}

async function hmac(masterHex: string, input: string): Promise<Buffer> {
	const key = await deriveKey(masterHex, STATE_PURPOSE);
	const h = createHmac('sha256', key);
	h.update(input);
	return h.digest();
}

async function sha256(input: string): Promise<Buffer> {
	const { createHash } = await import('node:crypto');
	const h = createHash('sha256');
	h.update(input);
	return h.digest();
}

function base64url(buf: Buffer | Uint8Array): string {
	return Buffer.from(buf)
		.toString('base64')
		.replace(/=+$/, '')
		.replace(/\+/g, '-')
		.replace(/\//g, '_');
}

function base64urlDecode(s: string): Buffer {
	const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
	return Buffer.from(padded, 'base64');
}
