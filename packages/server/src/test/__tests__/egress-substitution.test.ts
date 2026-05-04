import { describe, expect, it } from 'vitest';
import { type ResolvedSecret, substituteRequest } from '../../services/egress/substitution';

function makeSecret(
	name: string,
	value: string,
	hosts: string[],
	allowAll = false,
): ResolvedSecret {
	return { name, value, allowedHosts: hosts, allowAllHosts: allowAll };
}

const baseRequest = {
	url: 'https://api.anthropic.com/v1/messages',
	headers: {} as Record<string, string | string[] | undefined>,
	method: 'POST',
	host: 'api.anthropic.com',
};

describe('substituteRequest', () => {
	it('replaces a placeholder in a header on a host that is allow-listed', () => {
		const secrets = new Map([
			['ANTHROPIC_API_KEY', makeSecret('ANTHROPIC_API_KEY', 'sk-real', ['api.anthropic.com'])],
		]);
		const result = substituteRequest(
			{
				...baseRequest,
				headers: { authorization: 'Bearer __HEZO_SECRET_ANTHROPIC_API_KEY__' },
			},
			secrets,
		);
		expect(result.failure).toBeNull();
		expect(result.headers.authorization).toBe('Bearer sk-real');
		expect(result.headersChanged).toBe(true);
		expect(result.urlChanged).toBe(false);
		expect([...result.secretsUsed]).toEqual(['ANTHROPIC_API_KEY']);
	});

	it('replaces a placeholder embedded in a URL query string', () => {
		const secrets = new Map([['GH_TOKEN', makeSecret('GH_TOKEN', 'ghp_xxx', ['api.github.com'])]]);
		const result = substituteRequest(
			{
				...baseRequest,
				url: 'https://api.github.com/user?token=__HEZO_SECRET_GH_TOKEN__',
				host: 'api.github.com',
			},
			secrets,
		);
		expect(result.failure).toBeNull();
		expect(result.url).toBe('https://api.github.com/user?token=ghp_xxx');
		expect(result.urlChanged).toBe(true);
	});

	it('rejects an unknown placeholder with unknown_secret and does not substitute partial matches', () => {
		const secrets = new Map<string, ResolvedSecret>();
		const result = substituteRequest(
			{ ...baseRequest, headers: { authorization: 'Bearer __HEZO_SECRET_NOPE__' } },
			secrets,
		);
		expect(result.failure).toEqual({ kind: 'unknown_secret', name: 'NOPE' });
		expect(result.headers.authorization).toBe('Bearer __HEZO_SECRET_NOPE__');
		expect(result.secretsUsed.size).toBe(0);
	});

	it('rejects placeholders for hosts that are not on the allowlist', () => {
		const secrets = new Map([['SCOPED', makeSecret('SCOPED', 'val', ['allowed.example'])]]);
		const result = substituteRequest(
			{
				...baseRequest,
				host: 'attacker.example',
				url: 'https://attacker.example/x',
				headers: { authorization: 'Bearer __HEZO_SECRET_SCOPED__' },
			},
			secrets,
		);
		expect(result.failure).toEqual({
			kind: 'secret_not_allowed_for_host',
			name: 'SCOPED',
			host: 'attacker.example',
		});
	});

	it('honours allowAllHosts even when allowed_hosts is empty', () => {
		const secrets = new Map([['ANY', makeSecret('ANY', 'v', [], true)]]);
		const result = substituteRequest(
			{
				...baseRequest,
				host: 'random.example',
				url: 'https://random.example/x',
				headers: { authorization: 'Bearer __HEZO_SECRET_ANY__' },
			},
			secrets,
		);
		expect(result.failure).toBeNull();
		expect(result.headers.authorization).toBe('Bearer v');
	});

	it('honours wildcard allowed-host entries (e.g. *.googleapis.com)', () => {
		const secrets = new Map([['G_KEY', makeSecret('G_KEY', 'ya29', ['*.googleapis.com'])]]);
		const result = substituteRequest(
			{
				...baseRequest,
				host: 'storage.googleapis.com',
				url: 'https://storage.googleapis.com/x',
				headers: { authorization: 'Bearer __HEZO_SECRET_G_KEY__' },
			},
			secrets,
		);
		expect(result.failure).toBeNull();
		expect(result.headers.authorization).toBe('Bearer ya29');
	});

	it('handles array-valued headers without losing siblings', () => {
		const secrets = new Map([['T', makeSecret('T', 'real', ['x.example'])]]);
		const result = substituteRequest(
			{
				...baseRequest,
				host: 'x.example',
				url: 'https://x.example/y',
				headers: { 'x-multi': ['static', '__HEZO_SECRET_T__', 'plain'] },
			},
			secrets,
		);
		expect(result.failure).toBeNull();
		expect(result.headers['x-multi']).toEqual(['static', 'real', 'plain']);
	});

	it('returns no changes when no placeholder is present', () => {
		const result = substituteRequest(
			{ ...baseRequest, headers: { authorization: 'Bearer literal' } },
			new Map(),
		);
		expect(result.failure).toBeNull();
		expect(result.headersChanged).toBe(false);
		expect(result.urlChanged).toBe(false);
	});
});
