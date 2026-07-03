import { describe, expect, it } from 'vitest';
import {
	buildLoginMessage,
	buildPasswordLoginMessage,
	buildPasswordSetupMessage,
	buildSetupMessage,
	buildUnlockMessage,
	deriveAuthKeyPair,
	derivePasswordKeyPair,
	deriveUnlockKey,
	generatePasswordSalt,
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
		expect(buildPasswordLoginMessage('NONCE')).toBe('hezo-auth-v1:password-login:NONCE');
		expect(buildPasswordSetupMessage('PUB', 'SALT')).toBe('hezo-auth-v1:password-setup:PUB:SALT');
	});
});

describe('generatePasswordSalt', () => {
	it('returns 32-char lowercase hex', () => {
		expect(generatePasswordSalt()).toMatch(/^[0-9a-f]{32}$/);
	});

	it('is random (distinct across calls)', () => {
		expect(generatePasswordSalt()).not.toBe(generatePasswordSalt());
	});
});

describe('derivePasswordKeyPair', () => {
	const SALT = '00112233445566778899aabbccddeeff';

	it('is deterministic for the same password + salt', async () => {
		const a = await derivePasswordKeyPair('correct horse battery staple', SALT);
		const b = await derivePasswordKeyPair('correct horse battery staple', SALT);
		expect(a.privateKey).toEqual(b.privateKey);
		expect(a.privateKey).toHaveLength(32);
		expect(a.publicKeyHex).toBe(b.publicKeyHex);
		expect(a.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
	});

	it('differs for a different password', async () => {
		const a = await derivePasswordKeyPair('password', SALT);
		const b = await derivePasswordKeyPair('Password', SALT);
		expect(a.publicKeyHex).not.toBe(b.publicKeyHex);
	});

	it('differs for a different salt (per-admin separation)', async () => {
		const a = await derivePasswordKeyPair('password', SALT);
		const b = await derivePasswordKeyPair('password', 'ffffffffffffffffffffffffffffffff');
		expect(a.publicKeyHex).not.toBe(b.publicKeyHex);
	});

	it('produces a keypair whose signatures verify (login round-trip)', async () => {
		const salt = generatePasswordSalt();
		const { privateKey, publicKeyHex } = await derivePasswordKeyPair('hunter2!!', salt);
		const sig = signAuthMessage(privateKey, buildPasswordLoginMessage('deadbeef'));
		expect(verifyAuthSignature(publicKeyHex, buildPasswordLoginMessage('deadbeef'), sig)).toBe(
			true,
		);
		// A wrong password derives a different key, so its signature fails.
		const wrong = await derivePasswordKeyPair('hunter3!!', salt);
		const wrongSig = signAuthMessage(wrong.privateKey, buildPasswordLoginMessage('deadbeef'));
		expect(verifyAuthSignature(publicKeyHex, buildPasswordLoginMessage('deadbeef'), wrongSig)).toBe(
			false,
		);
	});
});
