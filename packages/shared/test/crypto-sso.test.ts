import { describe, expect, it } from 'vitest';
import { deriveAuthKeyPair, signAuthMessage } from '../src/crypto/auth';
import {
	buildSsoTokenMessage,
	checkSsoTokenFreshness,
	encodeSsoToken,
	parseIssuerPublicKeys,
	parseSsoToken,
	SSO_TOKEN_CLOCK_SKEW_SECONDS,
	SSO_TOKEN_DOMAIN,
	SSO_TOKEN_MAX_LIFETIME_SECONDS,
	type SsoTokenPayload,
	verifySsoTokenSignature,
} from '../src/crypto/sso';

const ISSUER = deriveAuthKeyPair('test test test test test test test test test test test junk');
const OTHER_ISSUER = deriveAuthKeyPair(
	'legal winner thank year wave sausage worth useful legal winner thank yellow',
);

const IAT = 1_760_000_000;
const PAYLOAD: SsoTokenPayload = {
	kid: 'k1',
	aud: 'alice.app.hezo.ai',
	sub: '9f1cb2d4-0000-4000-8000-000000000001',
	jti: 'b7d1e0f2a3c45566',
	iat: IAT,
	exp: IAT + 60,
};

function sign(payload: SsoTokenPayload, key = ISSUER): string {
	return signAuthMessage(key.privateKey, buildSsoTokenMessage(payload));
}

describe('buildSsoTokenMessage', () => {
	it('is deterministic and carries its own domain tag', () => {
		expect(buildSsoTokenMessage(PAYLOAD)).toBe(buildSsoTokenMessage(PAYLOAD));
		expect(buildSsoTokenMessage(PAYLOAD).startsWith(`${SSO_TOKEN_DOMAIN}:`)).toBe(true);
	});

	it('cannot be confused with the passphrase-signed auth family', () => {
		expect(buildSsoTokenMessage(PAYLOAD)).not.toContain('hezo-auth-v1');
	});

	// The defect length-prefixing exists to prevent: under a plain colon join,
	// moving a colon from the end of one field to the start of the next leaves
	// the signed bytes identical, so one signature covers both payloads.
	it('distinguishes payloads that a delimiter-only encoding would collide', () => {
		const a: SsoTokenPayload = { ...PAYLOAD, aud: 'a:b', sub: 'c' };
		const b: SsoTokenPayload = { ...PAYLOAD, aud: 'a', sub: 'b:c' };
		expect([a.kid, a.aud, a.sub, a.jti].join(':')).toBe([b.kid, b.aud, b.sub, b.jti].join(':'));
		expect(buildSsoTokenMessage(a)).not.toBe(buildSsoTokenMessage(b));
	});

	it('counts field widths in UTF-8 bytes, not code units', () => {
		const wide: SsoTokenPayload = { ...PAYLOAD, sub: 'é' };
		expect(buildSsoTokenMessage(wide)).toContain(':2:é');
	});
});

describe('encodeSsoToken / parseSsoToken', () => {
	it('round-trips a payload and its signature', () => {
		const parsed = parseSsoToken(encodeSsoToken(PAYLOAD, sign(PAYLOAD)));
		expect(parsed?.payload).toEqual(PAYLOAD);
		expect(parsed?.signatureHex).toBe(sign(PAYLOAD));
	});

	it('emits an unpadded URL-fragment-safe token', () => {
		expect(encodeSsoToken(PAYLOAD, sign(PAYLOAD))).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	it.each([
		['empty', ''],
		['outside the alphabet', 'not base64!!'],
		['valid base64url that is not JSON', 'aGVsbG8'],
	])('returns null for %s', (_label, token) => {
		expect(parseSsoToken(token)).toBeNull();
	});

	it.each(['kid', 'aud', 'sub', 'jti', 'sig'])('returns null when %s is missing', (field) => {
		const raw: Record<string, unknown> = { ...PAYLOAD, sig: sign(PAYLOAD) };
		delete raw[field];
		expect(parseSsoToken(base64Url(JSON.stringify(raw)))).toBeNull();
	});

	it.each([
		['iat is not an integer', { iat: 1.5 }],
		['exp is a string', { exp: '123' }],
		['iat is negative', { iat: -1 }],
		['kid is empty', { kid: '' }],
		['the signature is the wrong length', { sig: 'ab' }],
		['the signature is not hex', { sig: 'z'.repeat(128) }],
	])('returns null when %s', (_label, override) => {
		const raw = { ...PAYLOAD, sig: sign(PAYLOAD), ...override };
		expect(parseSsoToken(base64Url(JSON.stringify(raw)))).toBeNull();
	});
});

describe('verifySsoTokenSignature', () => {
	it('accepts a signature from the issuing key', () => {
		expect(verifySsoTokenSignature(PAYLOAD, sign(PAYLOAD), ISSUER.publicKeyHex)).toBe(true);
	});

	it('rejects a signature from a different key', () => {
		expect(verifySsoTokenSignature(PAYLOAD, sign(PAYLOAD, OTHER_ISSUER), ISSUER.publicKeyHex)).toBe(
			false,
		);
	});

	it.each<[keyof SsoTokenPayload, string | number]>([
		['kid', 'k2'],
		['aud', 'mallory.app.hezo.ai'],
		['sub', '9f1cb2d4-0000-4000-8000-000000000002'],
		['jti', 'ffffffffffffffff'],
		['iat', IAT + 1],
		['exp', IAT + 120],
	])('rejects a token whose %s was tampered with', (field, value) => {
		const signature = sign(PAYLOAD);
		const tampered = { ...PAYLOAD, [field]: value } as SsoTokenPayload;
		expect(verifySsoTokenSignature(tampered, signature, ISSUER.publicKeyHex)).toBe(false);
	});

	it('rejects a malformed signature without throwing', () => {
		expect(verifySsoTokenSignature(PAYLOAD, 'not-hex', ISSUER.publicKeyHex)).toBe(false);
	});
});

describe('checkSsoTokenFreshness', () => {
	it('accepts a token inside its window', () => {
		expect(checkSsoTokenFreshness(PAYLOAD, IAT + 30)).toBe('ok');
	});

	it('accepts the exact skew boundaries on both sides', () => {
		expect(checkSsoTokenFreshness(PAYLOAD, IAT - SSO_TOKEN_CLOCK_SKEW_SECONDS)).toBe('ok');
		expect(checkSsoTokenFreshness(PAYLOAD, PAYLOAD.exp + SSO_TOKEN_CLOCK_SKEW_SECONDS)).toBe('ok');
	});

	it('rejects one second beyond either boundary', () => {
		expect(checkSsoTokenFreshness(PAYLOAD, IAT - SSO_TOKEN_CLOCK_SKEW_SECONDS - 1)).toBe(
			'not-yet-valid',
		);
		expect(checkSsoTokenFreshness(PAYLOAD, PAYLOAD.exp + SSO_TOKEN_CLOCK_SKEW_SECONDS + 1)).toBe(
			'expired',
		);
	});

	// Skew tolerance absorbs drift; it must never excuse an over-wide window.
	it('rejects a window wider than the protocol allows, however fresh', () => {
		const long = { ...PAYLOAD, exp: IAT + SSO_TOKEN_MAX_LIFETIME_SECONDS + 1 };
		expect(checkSsoTokenFreshness(long, IAT)).toBe('lifetime-too-long');
	});

	it('rejects a window that ends before it starts', () => {
		expect(checkSsoTokenFreshness({ ...PAYLOAD, exp: IAT - 1 }, IAT)).toBe('lifetime-too-long');
		expect(checkSsoTokenFreshness({ ...PAYLOAD, exp: IAT }, IAT)).toBe('lifetime-too-long');
	});
});

describe('parseIssuerPublicKeys', () => {
	const A = 'a'.repeat(64);
	const B = 'b'.repeat(64);

	it('parses one key', () => {
		const result = parseIssuerPublicKeys(`k1:${A}`);
		expect(result).toEqual({ ok: true, keys: new Map([['k1', A]]) });
	});

	it('parses several, so an issuer can rotate without a flag day', () => {
		const result = parseIssuerPublicKeys(` k1:${A} , k2:${B} `);
		expect(result.ok && result.keys.get('k1')).toBe(A);
		expect(result.ok && result.keys.get('k2')).toBe(B);
	});

	it.each([
		['an empty list', '', 'no issuer keys listed'],
		['a missing separator', A, 'not in kid:hex form'],
		['an empty kid', `:${A}`, 'not in kid:hex form'],
		['a short key', 'k1:abcd', 'lowercase hex'],
		['an uppercase key', `k1:${A.toUpperCase()}`, 'lowercase hex'],
		['a duplicate kid', `k1:${A},k1:${B}`, 'listed more than once'],
	])('names the offending entry for %s', (_label, list, expected) => {
		const result = parseIssuerPublicKeys(list);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.error).toContain(expected);
	});
});

function base64Url(json: string): string {
	const bytes = new TextEncoder().encode(json);
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
	let out = '';
	let buffer = 0;
	let bits = 0;
	for (const byte of bytes) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (bits >= 6) {
			bits -= 6;
			out += alphabet[(buffer >> bits) & 63];
		}
	}
	if (bits > 0) out += alphabet[(buffer << (6 - bits)) & 63];
	return out;
}
