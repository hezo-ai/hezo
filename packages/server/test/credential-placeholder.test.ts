import { describe, expect, it } from 'vitest';
import {
	createPlaceholderRegex,
	credentialPlaceholder,
	extractPlaceholderNames,
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
