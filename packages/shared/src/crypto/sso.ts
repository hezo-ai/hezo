import { bytesToUtf8, utf8ToBytes } from '@noble/hashes/utils';
import { verifyAuthSignature } from './auth.js';

/**
 * Single sign-on assertions from an external issuer.
 *
 * Every other signed payload in this package is signed by a key the user's own
 * passphrase derives, under the `hezo-auth-v1:` tag. An SSO token is signed by
 * a key that belongs to a control plane instead, so it gets a tag family of its
 * own: no key rotation, parser bug or copied fixture can make one family's
 * signature satisfy the other's verifier.
 *
 * A token asserts *identity* and nothing else. It carries no key material, and
 * an instance that accepts one is not thereby unlocked.
 */

/** Domain tag. A signature over one family never verifies against another. */
export const SSO_TOKEN_DOMAIN = 'hezo-sso-v1';

/** Longest window an issuer may mint. Anything wider is refused as malformed. */
export const SSO_TOKEN_MAX_LIFETIME_SECONDS = 60;

/**
 * Allowance either side of the window, absorbing ordinary clock drift between
 * two independently-hosted machines.
 *
 * **It widens the accepted window on both sides**, so a token is takeable from
 * `iat - 30` to `exp + 30`: for the 60-second maximum above, two minutes rather
 * than one. That is the real figure to reason about, not the `exp` an issuer
 * writes. It is still far shorter than the time a captured token would need to
 * be worth carrying anywhere, and a token is spent on first use regardless.
 */
export const SSO_TOKEN_CLOCK_SKEW_SECONDS = 30;

/**
 * Longest token worth looking at. A real one is around 250 bytes.
 *
 * Decoding is the first thing an unauthenticated caller can make this process
 * do, and it is not free: a base64 decode plus a JSON parse, on the process that
 * is also the tool endpoint, the egress proxy and the container control plane.
 * Without a ceiling the only bound is the API body limit, and megabytes of
 * alphabet decode into hundreds of milliseconds of blocked event loop per
 * request. The throttle is not that bound - it is checked after verification, so
 * a valid token is never queued behind an attacker, which means the parse
 * happens either way. This is the bound.
 */
const MAX_TOKEN_LENGTH = 4096;

/** Ed25519 public keys are 32 bytes, carried as lowercase hex. */
const PUBLIC_KEY_HEX_LENGTH = 64;
const PUBLIC_KEY_HEX = new RegExp(`^[0-9a-f]{${PUBLIC_KEY_HEX_LENGTH}}$`);

export interface SsoTokenPayload {
	/** Which issuer key signed this, matching an entry in the configured list. */
	kid: string;
	/** The instance the token is minted for. Compared against configured value. */
	aud: string;
	/** The issuer's account identifier for the person signing in. */
	sub: string;
	/** Unique per mint, so a captured token cannot be presented twice. */
	jti: string;
	/** Issued-at, unix seconds. */
	iat: number;
	/** Expiry, unix seconds. */
	exp: number;
}

export interface ParsedSsoToken {
	payload: SsoTokenPayload;
	/** Ed25519 signature over {@link buildSsoTokenMessage}, lowercase hex. */
	signatureHex: string;
}

/**
 * Canonical bytes an issuer signs.
 *
 * Each field is length-prefixed rather than merely delimited. The other builders
 * in this package join fixed-length hex with colons, which is unambiguous only
 * because every field there has a known width. These fields are free text - a
 * hostname, an opaque key id - so a delimiter alone would let one field's tail
 * be read as the next field's head, and two different payloads would share a
 * signature. Prefixing each field with its UTF-8 byte length makes the encoding
 * injective: the reader takes exactly as many bytes as the prefix names.
 */
export function buildSsoTokenMessage(payload: SsoTokenPayload): string {
	return (
		SSO_TOKEN_DOMAIN +
		field(payload.kid) +
		field(payload.aud) +
		field(payload.sub) +
		field(payload.jti) +
		field(String(payload.iat)) +
		field(String(payload.exp))
	);
}

function field(value: string): string {
	return `:${utf8ToBytes(value).length}:${value}`;
}

/** True when the signature was made over this payload by this key. */
export function verifySsoTokenSignature(
	payload: SsoTokenPayload,
	signatureHex: string,
	publicKeyHex: string,
): boolean {
	return verifyAuthSignature(publicKeyHex, buildSsoTokenMessage(payload), signatureHex);
}

/**
 * Wire form: base64url of the payload plus its signature, unpadded so it travels
 * whole in a URL fragment.
 */
export function encodeSsoToken(payload: SsoTokenPayload, signatureHex: string): string {
	const json = JSON.stringify({ ...payload, sig: signatureHex });
	return bytesToBase64Url(utf8ToBytes(json));
}

/**
 * Decode a wire token. Returns null for anything that is not a well-formed
 * token - wrong alphabet, bad JSON, a missing or wrongly-typed field. Never
 * throws, and says nothing about whether the signature is good.
 */
export function parseSsoToken(token: string): ParsedSsoToken | null {
	if (token.length > MAX_TOKEN_LENGTH) return null;
	const bytes = base64UrlToBytes(token);
	if (!bytes) return null;

	let raw: unknown;
	try {
		raw = JSON.parse(bytesToUtf8(bytes));
	} catch {
		return null;
	}
	if (typeof raw !== 'object' || raw === null) return null;
	const o = raw as Record<string, unknown>;

	const kid = text(o.kid);
	const aud = text(o.aud);
	const sub = text(o.sub);
	const jti = text(o.jti);
	const sig = text(o.sig);
	const iat = seconds(o.iat);
	const exp = seconds(o.exp);
	if (
		kid === null ||
		aud === null ||
		sub === null ||
		jti === null ||
		sig === null ||
		iat === null ||
		exp === null
	) {
		return null;
	}
	if (!/^[0-9a-f]{128}$/.test(sig)) return null;

	return { payload: { kid, aud, sub, jti, iat, exp }, signatureHex: sig };
}

function text(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null;
}

function seconds(value: unknown): number | null {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export type SsoTokenFreshness = 'ok' | 'expired' | 'not-yet-valid' | 'lifetime-too-long';

/**
 * Where the token sits relative to the clock, allowing for skew.
 *
 * `lifetime-too-long` catches an issuer minting a wider window than the protocol
 * permits, which no amount of skew tolerance should excuse - a token good for an
 * hour is a different security posture, not a clock problem.
 */
export function checkSsoTokenFreshness(
	payload: SsoTokenPayload,
	nowSeconds: number,
): SsoTokenFreshness {
	const lifetime = payload.exp - payload.iat;
	if (lifetime <= 0 || lifetime > SSO_TOKEN_MAX_LIFETIME_SECONDS) return 'lifetime-too-long';
	if (nowSeconds < payload.iat - SSO_TOKEN_CLOCK_SKEW_SECONDS) return 'not-yet-valid';
	if (nowSeconds > payload.exp + SSO_TOKEN_CLOCK_SKEW_SECONDS) return 'expired';
	return 'ok';
}

export type IssuerKeyParse = { ok: true; keys: Map<string, string> } | { ok: false; error: string };

/**
 * Parse the configured `kid:hex,kid:hex` issuer key list.
 *
 * Publishing several keys at once is what lets an issuer rotate without a flag
 * day: add the new key, move minting to it, then drop the old one. The error
 * names the offending entry so a bad list fails at startup rather than at
 * someone's first sign-in.
 */
export function parseIssuerPublicKeys(list: string): IssuerKeyParse {
	const keys = new Map<string, string>();
	const entries = list
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	if (entries.length === 0) return { ok: false, error: 'no issuer keys listed' };

	for (const entry of entries) {
		const separator = entry.indexOf(':');
		if (separator <= 0) {
			return { ok: false, error: `"${entry}" is not in kid:hex form` };
		}
		const kid = entry.slice(0, separator);
		const hex = entry.slice(separator + 1);
		if (!PUBLIC_KEY_HEX.test(hex)) {
			return {
				ok: false,
				error: `key "${kid}" is not ${PUBLIC_KEY_HEX_LENGTH} lowercase hex characters`,
			};
		}
		if (keys.has(kid)) return { ok: false, error: `key "${kid}" is listed more than once` };
		keys.set(kid, hex);
	}
	return { ok: true, keys };
}

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function bytesToBase64Url(bytes: Uint8Array): string {
	let out = '';
	let buffer = 0;
	let bits = 0;
	for (const byte of bytes) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (bits >= 6) {
			bits -= 6;
			out += BASE64URL_ALPHABET[(buffer >> bits) & 63];
		}
	}
	if (bits > 0) out += BASE64URL_ALPHABET[(buffer << (6 - bits)) & 63];
	return out;
}

function base64UrlToBytes(value: string): Uint8Array | null {
	if (value.length === 0) return null;
	const out: number[] = [];
	let buffer = 0;
	let bits = 0;
	for (const ch of value) {
		const index = BASE64URL_ALPHABET.indexOf(ch);
		if (index < 0) return null;
		buffer = (buffer << 6) | index;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			out.push((buffer >> bits) & 0xff);
		}
	}
	// One encoding per token. The leftover bits of the final sextet are not part
	// of any byte, so a decoder that discards them accepts four spellings of the
	// same payload. Nothing downstream keys on the token string today - the
	// replay cache keys on `jti` - but "there is exactly one way to write this
	// token" is a cheaper property to keep than to re-establish later.
	if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) return null;
	return new Uint8Array(out);
}
