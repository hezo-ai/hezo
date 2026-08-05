import { describe, expect, it } from 'vitest';
import {
	createPlaceholderRegex,
	credentialPlaceholder,
	extractPlaceholderNames,
	normalizeAllowedHosts,
	PLACEHOLDER_PROBE,
	SECRET_NAME_PATTERN,
	validateSecretName,
} from '../src/lib/credential-placeholder';

describe('validateSecretName', () => {
	it('accepts a single uppercase letter', () => {
		expect(validateSecretName('A')).toEqual({ valid: true });
	});

	it('accepts uppercase letters, digits, and underscores up to 64 chars', () => {
		expect(validateSecretName('OPENAI_API_KEY_1')).toEqual({ valid: true });
		expect(validateSecretName('A'.repeat(64))).toEqual({ valid: true });
	});

	it('rejects an empty string', () => {
		const r = validateSecretName('');
		expect(r.valid).toBe(false);
		expect(r.valid === false && r.error).toBe('name is required');
	});

	it('rejects a non-string input', () => {
		// @ts-expect-error exercising the runtime type guard
		const r = validateSecretName(undefined);
		expect(r.valid).toBe(false);
	});

	it('rejects names that start with a digit or use lowercase', () => {
		expect(validateSecretName('1ABC').valid).toBe(false);
		expect(validateSecretName('lowercase').valid).toBe(false);
		expect(validateSecretName('HAS-DASH').valid).toBe(false);
	});

	it('rejects names longer than 64 chars', () => {
		expect(validateSecretName('A'.repeat(65)).valid).toBe(false);
	});
});

describe('credentialPlaceholder', () => {
	it('wraps a name in the probe prefix and trailing underscores', () => {
		expect(credentialPlaceholder('FOO')).toBe('__HEZO_SECRET_FOO__');
		expect(credentialPlaceholder('FOO').startsWith(PLACEHOLDER_PROBE)).toBe(true);
	});
});

describe('createPlaceholderRegex', () => {
	it('returns a fresh global regex on each call', () => {
		const a = createPlaceholderRegex();
		const b = createPlaceholderRegex();
		expect(a).not.toBe(b);
		expect(a.global).toBe(true);
	});

	it('matches a valid placeholder body', () => {
		expect(SECRET_NAME_PATTERN.test('GITHUB_PAT')).toBe(true);
		expect(createPlaceholderRegex().test('__HEZO_SECRET_GITHUB_PAT__')).toBe(true);
	});
});

describe('extractPlaceholderNames', () => {
	it('returns names of every placeholder, de-duplicated', () => {
		const input =
			'Authorization: Bearer __HEZO_SECRET_API_KEY__ and again __HEZO_SECRET_API_KEY__ plus __HEZO_SECRET_OTHER__';
		expect(extractPlaceholderNames(input).sort()).toEqual(['API_KEY', 'OTHER']);
	});

	it('returns an empty array when there are no placeholders', () => {
		expect(extractPlaceholderNames('nothing here')).toEqual([]);
	});

	it('ignores malformed placeholders (lowercase body)', () => {
		expect(extractPlaceholderNames('__HEZO_SECRET_lower__')).toEqual([]);
	});
});

describe('normalizeAllowedHosts', () => {
	// The proxy compares against a bare lowercase hostname (it strips the port from
	// the CONNECT target first), so an entry carrying a scheme or a port could
	// never match anything — and the failure was silent, surfacing as a 403 that
	// looked like a deliberate scoping decision rather than a typo.
	it('strips a scheme, port, path and userinfo down to the bare host', () => {
		expect(normalizeAllowedHosts(['https://api.stripe.com'])).toEqual(['api.stripe.com']);
		expect(normalizeAllowedHosts(['api.stripe.com:443'])).toEqual(['api.stripe.com']);
		expect(normalizeAllowedHosts(['https://api.stripe.com:443/v1/charges?x=1'])).toEqual([
			'api.stripe.com',
		]);
		expect(normalizeAllowedHosts(['http://user:pw@api.stripe.com/'])).toEqual(['api.stripe.com']);
	});

	it('lowercases, trims, and drops the fully-qualified trailing dot', () => {
		expect(normalizeAllowedHosts(['  API.Stripe.Com.  '])).toEqual(['api.stripe.com']);
	});

	it('leaves a wildcard entry intact', () => {
		expect(normalizeAllowedHosts(['*.googleapis.com'])).toEqual(['*.googleapis.com']);
	});

	it('preserves an IPv6 literal without its brackets or port', () => {
		expect(normalizeAllowedHosts(['[2606:4700::1111]:443'])).toEqual(['2606:4700::1111']);
	});

	it('drops empties and de-duplicates what normalizes to the same host', () => {
		expect(normalizeAllowedHosts(['api.foo.com', 'https://api.foo.com:443', '', '   '])).toEqual([
			'api.foo.com',
		]);
	});

	it('returns an empty array for a non-array input', () => {
		expect(normalizeAllowedHosts(undefined)).toEqual([]);
		expect(normalizeAllowedHosts('api.foo.com')).toEqual([]);
	});
});
