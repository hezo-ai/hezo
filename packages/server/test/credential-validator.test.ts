import { generateKeyPairSync } from 'node:crypto';
import { CredentialKind } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import { validateCredentialValue } from '../src/lib/credential-validator';

describe('validateCredentialValue — generic value checks', () => {
	it('rejects an empty string', () => {
		const r = validateCredentialValue(CredentialKind.ApiKey, '');
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.error).toBe('value is required');
	});

	it('rejects a non-string value', () => {
		// The function is declared with `value: string` but guards at runtime too.
		const r = validateCredentialValue(CredentialKind.ApiKey, undefined as unknown as string);
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.error).toBe('value is required');
	});

	it('rejects a value over the 64KB limit', () => {
		const big = 'a'.repeat(64 * 1024 + 1);
		const r = validateCredentialValue(CredentialKind.ApiKey, big);
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.error).toBe('value exceeds 64KB limit');
	});

	it('accepts a value exactly at the 64KB boundary', () => {
		const exactly = 'a'.repeat(64 * 1024);
		const r = validateCredentialValue(CredentialKind.ApiKey, exactly);
		expect(r.valid).toBe(true);
	});

	it('rejects an unknown credential kind', () => {
		const r = validateCredentialValue('definitely-not-a-kind', 'something');
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.error).toBe('unknown credential kind: definitely-not-a-kind');
	});
});

describe('validateCredentialValue — pass-through kinds', () => {
	for (const kind of [
		CredentialKind.ApiKey,
		CredentialKind.OauthToken,
		CredentialKind.WebhookSecret,
		CredentialKind.Other,
	]) {
		it(`accepts any non-empty value for ${kind}`, () => {
			const r = validateCredentialValue(kind, 'whatever-token-value-123');
			expect(r.valid).toBe(true);
		});
	}
});

describe('validateCredentialValue — SSH private key', () => {
	it('accepts a real RSA PEM private key', () => {
		const { privateKey } = generateKeyPairSync('rsa', {
			modulusLength: 2048,
			privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
			publicKeyEncoding: { type: 'spki', format: 'pem' },
		});
		const r = validateCredentialValue(CredentialKind.SshPrivateKey, privateKey);
		expect(r.valid).toBe(true);
	});

	it('accepts a real EC PEM private key with a typed BEGIN header', () => {
		const { privateKey } = generateKeyPairSync('ec', {
			namedCurve: 'prime256v1',
			privateKeyEncoding: { type: 'sec1', format: 'pem' },
			publicKeyEncoding: { type: 'spki', format: 'pem' },
		});
		// sec1 emits "-----BEGIN EC PRIVATE KEY-----", exercising the optional
		// "([A-Z]+ )?" group in the PEM regex.
		expect(privateKey).toContain('BEGIN EC PRIVATE KEY');
		const r = validateCredentialValue(CredentialKind.SshPrivateKey, privateKey);
		expect(r.valid).toBe(true);
	});

	it('trims surrounding whitespace before validating a PEM key', () => {
		const { privateKey } = generateKeyPairSync('rsa', {
			modulusLength: 2048,
			privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
			publicKeyEncoding: { type: 'spki', format: 'pem' },
		});
		const r = validateCredentialValue(CredentialKind.SshPrivateKey, `\n\n  ${privateKey}  \n`);
		expect(r.valid).toBe(true);
	});

	it('treats an OpenSSH header as PEM (regex matches OPENSSH) and parses the body', () => {
		// The PEM regex `^-----BEGIN ([A-Z]+ )?PRIVATE KEY-----` matches "OPENSSH
		// PRIVATE KEY" too, so isPem wins and createPrivateKey runs. A fake body
		// therefore fails to parse. (This makes the dedicated OpenSSH return at
		// lines 50-51 effectively unreachable — any string that satisfies the
		// OpenSSH startsWith also satisfies the PEM regex.)
		const openssh =
			'-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----';
		const r = validateCredentialValue(CredentialKind.SshPrivateKey, openssh);
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.error).toContain('failed to parse private key');
	});

	it('rejects a value that is not a PEM or OpenSSH key', () => {
		const r = validateCredentialValue(CredentialKind.SshPrivateKey, 'just some random text');
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.error).toContain('does not look like a PEM or OpenSSH private key');
	});

	it('rejects a PEM-headered value with corrupt body', () => {
		const corrupt =
			'-----BEGIN PRIVATE KEY-----\nnot-actually-valid-base64-key-material!!!\n-----END PRIVATE KEY-----';
		const r = validateCredentialValue(CredentialKind.SshPrivateKey, corrupt);
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.error).toContain('failed to parse private key');
	});
});

describe('validateCredentialValue — GitHub PAT', () => {
	it('accepts a classic ghp_ token', () => {
		const r = validateCredentialValue(CredentialKind.GithubPat, `ghp_${'a'.repeat(36)}`);
		expect(r.valid).toBe(true);
	});

	it('accepts a fine-grained github_pat_ token', () => {
		const r = validateCredentialValue(CredentialKind.GithubPat, `github_pat_${'A1b2_3'.repeat(6)}`);
		expect(r.valid).toBe(true);
	});

	it('accepts a gho_ OAuth token', () => {
		const r = validateCredentialValue(CredentialKind.GithubPat, `gho_${'Z'.repeat(36)}`);
		expect(r.valid).toBe(true);
	});

	it('trims whitespace before matching the prefix', () => {
		const r = validateCredentialValue(CredentialKind.GithubPat, `   ghp_${'a'.repeat(40)}\n`);
		expect(r.valid).toBe(true);
	});

	it('rejects a token without a recognised prefix', () => {
		const r = validateCredentialValue(CredentialKind.GithubPat, 'pat_1234567890abcdef');
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.error).toContain('does not look like a GitHub PAT');
	});

	it('rejects a ghp_ token that is too short', () => {
		const r = validateCredentialValue(CredentialKind.GithubPat, 'ghp_short');
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.error).toContain('does not look like a GitHub PAT');
	});
});
