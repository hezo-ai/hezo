import { ed25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { mnemonicToSeedSync } from '@scure/bip39';
import { normalizeMnemonic } from './mnemonic.js';

const HKDF_INFO = utf8ToBytes('hezo');
const UNLOCK_KEY_SALT = utf8ToBytes('hezo-unlock-key-v1');
const AUTH_KEY_SALT = utf8ToBytes('hezo-auth-key-v1');

export interface AuthKeyPair {
	/** 32-byte Ed25519 public key, lowercase hex (64 chars). Safe to share. */
	publicKeyHex: string;
	/** 32-byte Ed25519 private seed. Never serialized, never transmitted. */
	privateKey: Uint8Array;
}

/**
 * Deterministic words -> 32-byte unlock key, lowercase hex (64 chars). The only
 * key material the server ever receives: it feeds the server's canary /
 * encryption / JWT derivations and transits solely at setup and at
 * unlock-after-restart, inside an Ed25519-signed payload. Salt-separated from
 * the auth keypair so neither derived key reveals the other. Identical output
 * in the browser (esbuild) and Node/Bun (pure JS, no node:crypto).
 */
export function deriveUnlockKey(phrase: string): string {
	const seed = mnemonicToSeedSync(normalizeMnemonic(phrase)); // 64 bytes
	return bytesToHex(hkdf(sha256, seed, UNLOCK_KEY_SALT, HKDF_INFO, 32));
}

/**
 * Deterministic words -> Ed25519 keypair for challenge-response auth. The
 * private seed never leaves the client; the public key is enrolled on the
 * server at setup and verifies login/unlock signatures thereafter.
 */
export function deriveAuthKeyPair(phrase: string): AuthKeyPair {
	const seed = mnemonicToSeedSync(normalizeMnemonic(phrase));
	const privateKey = hkdf(sha256, seed, AUTH_KEY_SALT, HKDF_INFO, 32);
	return { publicKeyHex: bytesToHex(ed25519.getPublicKey(privateKey)), privateKey };
}

/** Ed25519 signature over the UTF-8 message, lowercase hex (128 chars). */
export function signAuthMessage(privateKey: Uint8Array, message: string): string {
	return bytesToHex(ed25519.sign(utf8ToBytes(message), privateKey));
}

/** Verify an Ed25519 signature. Never throws — malformed input returns false. */
export function verifyAuthSignature(
	publicKeyHex: string,
	message: string,
	signatureHex: string,
): boolean {
	try {
		return ed25519.verify(hexToBytes(signatureHex), utf8ToBytes(message), hexToBytes(publicKeyHex));
	} catch {
		return false;
	}
}

// Canonical signed payloads. Versioned domain tags + fixed-length hex fields
// (colon-delimited) keep a signature from one flow from being replayed in
// another.

export function buildSetupMessage(publicKeyHex: string, unlockKeyHex: string): string {
	return `hezo-auth-v1:setup:${publicKeyHex}:${unlockKeyHex}`;
}

export function buildLoginMessage(nonceHex: string): string {
	return `hezo-auth-v1:login:${nonceHex}`;
}

export function buildUnlockMessage(nonceHex: string, unlockKeyHex: string): string {
	return `hezo-auth-v1:unlock:${nonceHex}:${unlockKeyHex}`;
}
