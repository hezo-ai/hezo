import { ed25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { scryptAsync } from '@noble/hashes/scrypt';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils';
import { mnemonicToSeedSync } from '@scure/bip39';
import { normalizeMnemonic } from './mnemonic.js';

const HKDF_INFO = utf8ToBytes('hezo');
const UNLOCK_KEY_SALT = utf8ToBytes('hezo-unlock-key-v1');
const AUTH_KEY_SALT = utf8ToBytes('hezo-auth-key-v1');

// scrypt cost for password-derived keys. Memory-hard so a leaked verifier is
// expensive to brute-force offline; tuned to stay ~sub-second in the browser.
//
// Under the test runtime ONLY, HEZO_TEST_SCRYPT_LOG_N lowers N to 2**<log-n> so
// the otherwise ~280ms derivation every createTestApp runs (once per test's
// beforeEach) becomes near-instant. Enrollment and login both go through
// derivePasswordKeyPair, so they read identical params and stay in lockstep
// within a run. The NODE_ENV==='test' gate means a stray env var can never
// weaken a real deployment, and the override is clamped to [1, 15] so this path
// can only ever *lower* the cost, never raise it. Env is read through globalThis
// so the browser (where `process` is absent, or its NODE_ENV is 'production')
// falls straight through to the production default.
const DEFAULT_SCRYPT_LOG_N = 15;

function passwordScryptParams(): { N: number; r: number; p: number; dkLen: number } {
	let logN = DEFAULT_SCRYPT_LOG_N;
	// Read env via globalThis so this stays browser-safe and needs no @types/node
	// (the shared package deliberately ships without Node typings). In a browser
	// `globalThis.process` is undefined → env is undefined → production default.
	const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
		?.env;
	if (env?.NODE_ENV === 'test') {
		const override = Number(env.HEZO_TEST_SCRYPT_LOG_N);
		if (Number.isInteger(override) && override >= 1 && override <= DEFAULT_SCRYPT_LOG_N) {
			logN = override;
		}
	}
	return { N: 2 ** logN, r: 8, p: 1, dkLen: 32 };
}

export interface AuthKeyPair {
	/** 32-byte Ed25519 public key, lowercase hex (64 chars). Safe to share. */
	publicKeyHex: string;
	/** 32-byte Ed25519 private seed. Never serialized, never transmitted. */
	privateKey: Uint8Array;
}

/**
 * Deterministic words -> 32-byte unlock key, lowercase hex (64 chars). The only
 * key material the server ever receives: it feeds the server's canary /
 * encryption / JWT derivations. A new process starts locked by default. The key
 * reaches it inside a signed web setup or unlock payload, through a supervised
 * update's in-memory IPC handoff, or by direct startup injection after deriving
 * deliberate one-shot `--master-key` or `HEZO_MASTER_KEY` input. Salt-separated
 * from the auth keypair so neither derived key reveals the other. Identical
 * output in the browser (esbuild) and Node/Bun (pure JS, no node:crypto).
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

// --- Password auth ------------------------------------------------------------
//
// A password is a low-entropy secret, so it is NEVER sent to the server. It is
// treated exactly like the mnemonic: a seed for an Ed25519 keypair derived via a
// memory-hard KDF (scrypt) with a per-admin salt. The server stores only the
// public key + salt (the "verifier") and authenticates by verifying a signature
// over a one-time server nonce. Only public keys, salts, and one-time signatures
// ever cross the wire — never the password or its derived private key.

/** Random 16-byte salt, lowercase hex (32 chars). Not secret; sent to the client. */
export function generatePasswordSalt(): string {
	return bytesToHex(randomBytes(16));
}

/**
 * Deterministic password + salt -> Ed25519 keypair via scrypt. Runs identically
 * in the browser and in Node/Bun (pure JS), so the verifier the client enrolls
 * matches what the server-side backfill computes. Async because scrypt is
 * intentionally slow — never block a UI thread or Bun's event loop on it.
 */
export async function derivePasswordKeyPair(
	password: string,
	saltHex: string,
): Promise<AuthKeyPair> {
	const seed = await scryptAsync(
		utf8ToBytes(password),
		hexToBytes(saltHex),
		passwordScryptParams(),
	);
	return { publicKeyHex: bytesToHex(ed25519.getPublicKey(seed)), privateKey: seed };
}

export function buildPasswordLoginMessage(nonceHex: string): string {
	return `hezo-auth-v1:password-login:${nonceHex}`;
}

export function buildPasswordSetupMessage(publicKeyHex: string, saltHex: string): string {
	return `hezo-auth-v1:password-setup:${publicKeyHex}:${saltHex}`;
}
