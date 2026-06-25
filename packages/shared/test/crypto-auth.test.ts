import { describe, expect, it } from 'vitest';
import {
	buildLoginMessage,
	buildSetupMessage,
	buildUnlockMessage,
	deriveAuthKeyPair,
	deriveUnlockKey,
	signAuthMessage,
	verifyAuthSignature,
} from '../src/crypto/auth';

// mnemonicToSeedSync does not validate the BIP39 checksum, so any phrase derives
// deterministically — these fixtures are stable inputs, not security material.
const PHRASE = 'test test test test test test test test test test test junk';
const OTHER = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

describe('deriveUnlockKey', () => {
	it('is deterministic and returns 64-char lowercase hex', () => {
		const a = deriveUnlockKey(PHRASE);
		expect(a).toBe(deriveUnlockKey(PHRASE));
		expect(a).toMatch(/^[0-9a-f]{64}$/);
	});

	it('normalizes whitespace and case before deriving', () => {
		const messy = '  TEST   test\ttest test test test test test test test test junk  ';
		expect(deriveUnlockKey(messy)).toBe(deriveUnlockKey(PHRASE));
	});

	it('differs for a different phrase', () => {
		expect(deriveUnlockKey(PHRASE)).not.toBe(deriveUnlockKey(OTHER));
	});
});

describe('deriveAuthKeyPair', () => {
	it('derives a deterministic 32-byte private key and 64-char hex public key', () => {
		const a = deriveAuthKeyPair(PHRASE);
		const b = deriveAuthKeyPair(PHRASE);
		expect(a.privateKey).toEqual(b.privateKey);
		expect(a.privateKey).toHaveLength(32);
		expect(a.publicKeyHex).toBe(b.publicKeyHex);
		expect(a.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
	});

	it('is salt-separated from the unlock key', () => {
		expect(deriveAuthKeyPair(PHRASE).publicKeyHex).not.toBe(deriveUnlockKey(PHRASE));
	});
});

describe('signAuthMessage / verifyAuthSignature', () => {
	it('round-trips a valid signature', () => {
		const { privateKey, publicKeyHex } = deriveAuthKeyPair(PHRASE);
		const sig = signAuthMessage(privateKey, 'hello');
		expect(sig).toMatch(/^[0-9a-f]{128}$/);
		expect(verifyAuthSignature(publicKeyHex, 'hello', sig)).toBe(true);
	});

	it('rejects a tampered message', () => {
		const { privateKey, publicKeyHex } = deriveAuthKeyPair(PHRASE);
		const sig = signAuthMessage(privateKey, 'hello');
		expect(verifyAuthSignature(publicKeyHex, 'hello!', sig)).toBe(false);
	});

	it('rejects a signature from a different key', () => {
		const a = deriveAuthKeyPair(PHRASE);
		const b = deriveAuthKeyPair(OTHER);
		const sig = signAuthMessage(a.privateKey, 'hello');
		expect(verifyAuthSignature(b.publicKeyHex, 'hello', sig)).toBe(false);
	});

	it('returns false (never throws) on malformed hex', () => {
		expect(verifyAuthSignature('not-hex', 'hello', 'also-not-hex')).toBe(false);
		expect(verifyAuthSignature('', '', '')).toBe(false);
	});
});

describe('canonical signed payloads', () => {
	it('builds versioned, domain-separated messages', () => {
		expect(buildSetupMessage('PUB', 'UNLOCK')).toBe('hezo-auth-v1:setup:PUB:UNLOCK');
		expect(buildLoginMessage('NONCE')).toBe('hezo-auth-v1:login:NONCE');
		expect(buildUnlockMessage('NONCE', 'UNLOCK')).toBe('hezo-auth-v1:unlock:NONCE:UNLOCK');
	});
});
