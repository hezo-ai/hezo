import { describe, expect, it } from 'vitest';
import {
	buildAuthorizationUrl,
	discoverMetadata,
	exchangeCode,
	type FetchFn,
} from '../src/services/oauth/provider-generic';

/**
 * Branch-coverage companion for `provider-generic.ts`. The existing
 * `oauth-generic-provider.test.ts` covers the happy paths via a real HTTP
 * sim; this file drives the conditional branches the sim doesn't reach using a
 * stub `FetchFn` (the production code accepts an injected fetch): the
 * openid-configuration fallback, missing-endpoints rejection, the
 * resource/additionalParams/`?`-in-url query branches of `buildAuthorizationUrl`,
 * and `exchangeCode`'s clientSecret / additionalParams / urlencoded-body /
 * missing-access_token / no-expiry branches.
 */

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

describe('discoverMetadata branches', () => {
	it('falls back to openid-configuration when oauth-authorization-server is not ok', async () => {
		const seen: string[] = [];
		const fetchFn: FetchFn = async (input) => {
			const url = String(input);
			seen.push(url);
			if (url.endsWith('/.well-known/oauth-authorization-server')) {
				return new Response('not found', { status: 404 });
			}
			return jsonResponse({
				issuer: 'https://op',
				authorization_endpoint: 'https://op/authorize',
				token_endpoint: 'https://op/token',
			});
		};
		const md = await discoverMetadata('https://op/mcp', fetchFn);
		expect(md.authorization_endpoint).toBe('https://op/authorize');
		expect(seen).toHaveLength(2);
		expect(seen[0]).toContain('/.well-known/oauth-authorization-server');
		expect(seen[1]).toContain('/.well-known/openid-configuration');
	});

	it('skips a candidate that is missing required endpoints, then errors when none qualify', async () => {
		const fetchFn: FetchFn = async (input) => {
			const url = String(input);
			if (url.endsWith('/.well-known/oauth-authorization-server')) {
				// 200 but missing token_endpoint → must be skipped, not returned.
				return jsonResponse({ authorization_endpoint: 'https://op/authorize' });
			}
			// openid fallback also incomplete (missing authorization_endpoint).
			return jsonResponse({ token_endpoint: 'https://op/token' });
		};
		await expect(discoverMetadata('https://op/mcp', fetchFn)).rejects.toThrow(
			/missing required endpoints/,
		);
	});

	it('reports the thrown fetch error in the aggregate message', async () => {
		const fetchFn: FetchFn = async () => {
			throw new Error('connect ECONNREFUSED');
		};
		await expect(discoverMetadata('https://op/mcp', fetchFn)).rejects.toThrow(/ECONNREFUSED/);
	});
});

describe('buildAuthorizationUrl branches', () => {
	it('appends resource + additionalParams and uses & when the authorize URL already has a query', () => {
		const url = buildAuthorizationUrl({
			authorizeUrl: 'https://provider/auth?foo=bar',
			clientId: 'c1',
			scopes: ['read'],
			redirectUri: 'http://localhost/cb',
			state: 'st',
			codeChallenge: 'cc',
			resource: 'https://mcp.example/mcp',
			additionalParams: { prompt: 'consent', audience: 'aud-1' },
		});
		// Pre-existing query is preserved (joined with &, not ?).
		expect(url).toContain('https://provider/auth?foo=bar&');
		const parsed = new URL(url);
		expect(parsed.searchParams.get('foo')).toBe('bar');
		expect(parsed.searchParams.get('resource')).toBe('https://mcp.example/mcp');
		expect(parsed.searchParams.get('prompt')).toBe('consent');
		expect(parsed.searchParams.get('audience')).toBe('aud-1');
	});

	it('omits resource when not provided and uses ? for a query-less authorize URL', () => {
		const url = buildAuthorizationUrl({
			authorizeUrl: 'https://provider/auth',
			clientId: 'c1',
			scopes: ['read', 'write'],
			redirectUri: 'http://localhost/cb',
			state: 'st',
			codeChallenge: 'cc',
		});
		expect(url.startsWith('https://provider/auth?')).toBe(true);
		expect(new URL(url).searchParams.get('resource')).toBeNull();
	});
});

describe('exchangeCode branches', () => {
	const TOKEN_URL = 'https://provider/token';

	it('sends client_secret + additionalParams in the form body', async () => {
		let capturedBody = '';
		const fetchFn: FetchFn = async (_input, init) => {
			capturedBody = String(init?.body);
			return jsonResponse({ access_token: 'at-1', token_type: 'bearer' });
		};
		const res = await exchangeCode(
			{
				tokenUrl: TOKEN_URL,
				clientId: 'c1',
				clientSecret: 'shh',
				code: 'code-1',
				codeVerifier: 'verifier-1',
				redirectUri: 'http://localhost/cb',
				additionalParams: { audience: 'aud-1' },
			},
			fetchFn,
		);
		expect(res.accessToken).toBe('at-1');
		expect(capturedBody).toContain('client_secret=shh');
		expect(capturedBody).toContain('audience=aud-1');
	});

	it('parses a urlencoded (non-JSON) token response body', async () => {
		const fetchFn: FetchFn = async () =>
			new Response('access_token=url-tok&token_type=bearer&scope=read', {
				status: 200,
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			});
		const res = await exchangeCode(
			{
				tokenUrl: TOKEN_URL,
				clientId: 'c1',
				code: 'code-1',
				codeVerifier: 'v',
				redirectUri: 'http://localhost/cb',
			},
			fetchFn,
		);
		expect(res.accessToken).toBe('url-tok');
		expect(res.scope).toBe('read');
		// No expires_in → expiresAt stays null.
		expect(res.expiresAt).toBeNull();
		// No refresh_token → null.
		expect(res.refreshToken).toBeNull();
	});

	it('throws with a bare status code when an error body lacks the error field', async () => {
		const fetchFn: FetchFn = async () =>
			new Response('upstream exploded', { status: 502, headers: { 'Content-Type': 'text/plain' } });
		await expect(
			exchangeCode(
				{
					tokenUrl: TOKEN_URL,
					clientId: 'c1',
					code: 'code-1',
					codeVerifier: 'v',
					redirectUri: 'http://localhost/cb',
				},
				fetchFn,
			),
		).rejects.toThrow(/token endpoint error: 502/);
	});

	it('throws when a 200 response carries no access_token', async () => {
		const fetchFn: FetchFn = async () => jsonResponse({ token_type: 'bearer', scope: 'read' });
		await expect(
			exchangeCode(
				{
					tokenUrl: TOKEN_URL,
					clientId: 'c1',
					code: 'code-1',
					codeVerifier: 'v',
					redirectUri: 'http://localhost/cb',
				},
				fetchFn,
			),
		).rejects.toThrow(/missing access_token/);
	});
});
