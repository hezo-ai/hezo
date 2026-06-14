import {
	buildLoginMessage,
	buildSetupMessage,
	buildUnlockMessage,
	deriveAuthKeyPair,
	deriveUnlockKey,
	signAuthMessage,
	verifyAuthSignature,
} from '@hezo/shared';
import { describe, expect, it } from 'vitest';

// Canonical BIP39 test vector (the all-"abandon" phrase). The pinned outputs
// catch any drift in the HKDF salts, the BIP39 seed derivation, or the noble
// libraries — a silent change here would strand every existing instance.
const VECTOR =
	'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const VECTOR_UNLOCK_KEY = '1b9b632446707426957408aed76cd1a45d3494e8609584eb74189b7742e10dad';
const VECTOR_PUBLIC_KEY = 'dbb05bb48f810ee380f91dcda76e3b1f3a343297ac691f2899e7f7d6afea43cc';

describe('deriveUnlockKey', () => {
	it('derives the pinned unlock key for the canonical vector', () => {
		const hex = deriveUnlockKey(VECTOR);
		expect(hex).toBe(VECTOR_UNLOCK_KEY);
		expect(hex).toMatch(/^[0-9a-f]{64}$/);
	});

	it('is deterministic and normalizes whitespace/case', () => {
		const messy = `  ABANDON   abandon\tabandon abandon abandon abandon
			abandon abandon abandon abandon abandon ABOUT  `;
		expect(deriveUnlockKey(messy)).toBe(VECTOR_UNLOCK_KEY);
	});
});

describe('deriveAuthKeyPair', () => {
	it('derives the pinned public key for the canonical vector', () => {
		const keys = deriveAuthKeyPair(VECTOR);
		expect(keys.publicKeyHex).toBe(VECTOR_PUBLIC_KEY);
		expect(keys.privateKey).toHaveLength(32);
	});

	it('is salt-separated from the unlock key', () => {
		const keys = deriveAuthKeyPair(VECTOR);
		expect(Buffer.from(keys.privateKey).toString('hex')).not.toBe(VECTOR_UNLOCK_KEY);
	});

	it('different phrases produce different keypairs', () => {
		const other = deriveAuthKeyPair(
			'legal winner thank year wave sausage worth useful legal winner thank yellow',
		);
		expect(other.publicKeyHex).not.toBe(VECTOR_PUBLIC_KEY);
	});
});

describe('signAuthMessage / verifyAuthSignature', () => {
	const keys = deriveAuthKeyPair(VECTOR);

	it('roundtrips', () => {
		const sig = signAuthMessage(keys.privateKey, 'hello');
		expect(sig).toMatch(/^[0-9a-f]{128}$/);
		expect(verifyAuthSignature(keys.publicKeyHex, 'hello', sig)).toBe(true);
	});

	it('rejects a tampered message', () => {
		const sig = signAuthMessage(keys.privateKey, 'hello');
		expect(verifyAuthSignature(keys.publicKeyHex, 'hellO', sig)).toBe(false);
	});

	it('rejects a signature from a different keypair', () => {
		const other = deriveAuthKeyPair(
			'legal winner thank year wave sausage worth useful legal winner thank yellow',
		);
		const sig = signAuthMessage(other.privateKey, 'hello');
		expect(verifyAuthSignature(keys.publicKeyHex, 'hello', sig)).toBe(false);
	});

	it('returns false (never throws) on malformed inputs', () => {
		const sig = signAuthMessage(keys.privateKey, 'hello');
		expect(verifyAuthSignature('not-hex', 'hello', sig)).toBe(false);
		expect(verifyAuthSignature(keys.publicKeyHex, 'hello', 'zz')).toBe(false);
		expect(verifyAuthSignature('', 'hello', '')).toBe(false);
		expect(verifyAuthSignature('ab', 'hello', sig)).toBe(false);
	});
});

describe('canonical messages', () => {
	it('pin the exact wire formats', () => {
		expect(buildSetupMessage('aa', 'bb')).toBe('hezo-auth-v1:setup:aa:bb');
		expect(buildLoginMessage('cc')).toBe('hezo-auth-v1:login:cc');
		expect(buildUnlockMessage('cc', 'bb')).toBe('hezo-auth-v1:unlock:cc:bb');
	});

	it('a login signature does not verify as an unlock signature', () => {
		const keys = deriveAuthKeyPair(VECTOR);
		const nonce = 'cc'.repeat(32);
		const sig = signAuthMessage(keys.privateKey, buildLoginMessage(nonce));
		expect(
			verifyAuthSignature(keys.publicKeyHex, buildUnlockMessage(nonce, VECTOR_UNLOCK_KEY), sig),
		).toBe(false);
	});
});
