import { createPrivateKey, createPublicKey, randomUUID, sign, verify } from 'node:crypto';

export interface StatePayload {
	callback_url: string;
	platform: string;
	nonce: string;
	timestamp: string;
	original_state?: string;
}

export interface StateKeyPair {
	privateKey: string; // PEM
	publicKey: string; // PEM
}

export function signState(payload: StatePayload, privateKeyPem: string): string {
	const json = JSON.stringify(payload);
	const encoded = Buffer.from(json).toString('base64url');
	const key = createPrivateKey(privateKeyPem);
	const signature = sign(null, Buffer.from(encoded), key).toString('base64url');
	return `${encoded}.${signature}`;
}

export function verifyState(signedState: string, publicKeyPem: string): StatePayload | null {
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

export function createNonce(): string {
	return randomUUID();
}

const NONCE_TTL_MS = 5 * 60 * 1000;

export class NonceStore {
	private nonces = new Map<string, number>();

	add(nonce: string): void {
		this.cleanup();
		this.nonces.set(nonce, Date.now() + NONCE_TTL_MS);
	}

	consume(nonce: string): boolean {
		this.cleanup();
		if (!this.nonces.has(nonce)) return false;
		this.nonces.delete(nonce);
		return true;
	}

	private cleanup(): void {
		const now = Date.now();
		for (const [nonce, expiry] of this.nonces) {
			if (expiry < now) this.nonces.delete(nonce);
		}
	}
}
