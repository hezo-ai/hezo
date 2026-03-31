import { describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import type { ConnectConfig } from '../../config.js';
import { verifyState } from '../../crypto/state.js';
import type { FetchFn } from '../../providers/github.js';

const SIGNING_KEY = 'test-signing-key-for-oauth-tests';

function makeConfig(github?: { clientId: string; clientSecret: string }): ConnectConfig {
	return {
		port: 4100,
		mode: 'self_hosted',
		stateSigningKey: SIGNING_KEY,
		github,
	};
}

function mockFetchFn(
	tokenResponse: Record<string, unknown>,
	userInfo: Record<string, unknown>,
): FetchFn {
	return async (input: string | URL | Request) => {
		const url =
			typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

		if (url.includes('github.com/login/oauth/access_token')) {
			return new Response(JSON.stringify(tokenResponse), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		if (url.includes('api.github.com/user')) {
			return new Response(JSON.stringify(userInfo), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		return new Response('Not found', { status: 404 });
	};
}

describe('GET /auth/:platform/start', () => {
	it('returns 400 without callback param', async () => {
		const app = createApp(makeConfig({ clientId: 'id', clientSecret: 'secret' }));
		const res = await app.request('/auth/github/start');
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('missing_callback');
	});

	it('redirects to error when GitHub is not configured', async () => {
		const app = createApp(makeConfig());
		const res = await app.request(
			'/auth/github/start?callback=http://localhost:3100/oauth/callback',
		);
		expect(res.status).toBe(302);
		const location = res.headers.get('Location')!;
		const url = new URL(location);
		expect(url.searchParams.get('error')).toBe('missing_config');
	});

	it('returns 400 for unsupported platform', async () => {
		const app = createApp(makeConfig({ clientId: 'id', clientSecret: 'secret' }));
		const res = await app.request(
			'/auth/unsupported/start?callback=http://localhost:3100/oauth/callback',
		);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('unsupported_platform');
	});

	it('redirects to GitHub OAuth with correct params', async () => {
		const app = createApp(makeConfig({ clientId: 'my-client-id', clientSecret: 'secret' }));
		const res = await app.request(
			'/auth/github/start?callback=http://localhost:3100/oauth/callback',
		);
		expect(res.status).toBe(302);
		const location = res.headers.get('Location')!;
		const url = new URL(location);
		expect(url.hostname).toBe('github.com');
		expect(url.pathname).toBe('/login/oauth/authorize');
		expect(url.searchParams.get('client_id')).toBe('my-client-id');
		expect(url.searchParams.get('scope')).toBe('repo,workflow,read:org');
		expect(url.searchParams.get('state')).toBeTruthy();
	});
});

describe('GET /auth/:platform/callback', () => {
	it('returns 400 with invalid state', async () => {
		const app = createApp(makeConfig({ clientId: 'id', clientSecret: 'secret' }));
		const res = await app.request('/auth/github/callback?code=test-code&state=invalid.state');
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('invalid_state');
	});

	it('returns 400 without state param', async () => {
		const app = createApp(makeConfig({ clientId: 'id', clientSecret: 'secret' }));
		const res = await app.request('/auth/github/callback?code=test-code');
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('invalid_state');
	});

	it('returns 400 for unsupported platform in callback', async () => {
		const app = createApp(makeConfig({ clientId: 'id', clientSecret: 'secret' }));
		const res = await app.request('/auth/unsupported/callback?code=c&state=s.s');
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe('unsupported_platform');
	});
});

describe('full OAuth flow with mocked GitHub API', () => {
	it('completes start → callback → redirect with tokens', async () => {
		const fetchFn = mockFetchFn(
			{ access_token: 'gho_mock_token', token_type: 'bearer', scope: 'repo,workflow,read:org' },
			{
				login: 'testuser',
				avatar_url: 'https://avatars.githubusercontent.com/u/1',
				email: 'test@example.com',
			},
		);
		const config = makeConfig({ clientId: 'cid', clientSecret: 'csecret' });
		const app = createApp(config, fetchFn);

		// Step 1: Start the flow
		const startRes = await app.request(
			'http://localhost:4100/auth/github/start?callback=http://localhost:3100/oauth/callback&state=user-data',
		);
		expect(startRes.status).toBe(302);
		const githubUrl = new URL(startRes.headers.get('Location')!);
		const signedState = githubUrl.searchParams.get('state')!;

		// Verify the state is valid
		const payload = verifyState(signedState, SIGNING_KEY);
		expect(payload).not.toBeNull();
		expect(payload?.callback_url).toBe('http://localhost:3100/oauth/callback');
		expect(payload?.platform).toBe('github');
		expect(payload?.original_state).toBe('user-data');

		// Step 2: Simulate GitHub callback
		const callbackRes = await app.request(
			`http://localhost:4100/auth/github/callback?code=mock-code&state=${encodeURIComponent(signedState)}`,
		);
		expect(callbackRes.status).toBe(302);

		// Step 3: Verify the final redirect
		const finalUrl = new URL(callbackRes.headers.get('Location')!);
		expect(finalUrl.origin + finalUrl.pathname).toBe('http://localhost:3100/oauth/callback');
		expect(finalUrl.searchParams.get('platform')).toBe('github');
		expect(finalUrl.searchParams.get('access_token')).toBe('gho_mock_token');
		expect(finalUrl.searchParams.get('scopes')).toBe('repo,workflow,read:org');
		expect(finalUrl.searchParams.get('state')).toBe('user-data');

		// Verify metadata contains user info
		const metadata = JSON.parse(
			Buffer.from(finalUrl.searchParams.get('metadata')!, 'base64url').toString('utf8'),
		);
		expect(metadata.username).toBe('testuser');
		expect(metadata.avatar_url).toBe('https://avatars.githubusercontent.com/u/1');
		expect(metadata.email).toBe('test@example.com');
	});

	it('redirects with error when token exchange fails', async () => {
		const fetchFn: FetchFn = async () =>
			new Response(JSON.stringify({ error: 'bad_verification_code' }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});

		const config = makeConfig({ clientId: 'cid', clientSecret: 'csecret' });
		const app = createApp(config, fetchFn);

		// Start the flow to get a valid state
		const startRes = await app.request(
			'http://localhost:4100/auth/github/start?callback=http://localhost:3100/oauth/callback',
		);
		const githubUrl = new URL(startRes.headers.get('Location')!);
		const signedState = githubUrl.searchParams.get('state')!;

		// Callback with the bad code
		const callbackRes = await app.request(
			`http://localhost:4100/auth/github/callback?code=bad-code&state=${encodeURIComponent(signedState)}`,
		);
		expect(callbackRes.status).toBe(302);
		const errorUrl = new URL(callbackRes.headers.get('Location')!);
		expect(errorUrl.searchParams.get('error')).toBe('token_exchange_failed');
		expect(errorUrl.searchParams.get('platform')).toBe('github');
	});

	it('nonce cannot be reused', async () => {
		const fetchFn = mockFetchFn(
			{ access_token: 'gho_token', token_type: 'bearer', scope: 'repo' },
			{ login: 'user', avatar_url: 'https://example.com/avatar', email: null },
		);
		const config = makeConfig({ clientId: 'cid', clientSecret: 'csecret' });
		const app = createApp(config, fetchFn);

		// Start the flow
		const startRes = await app.request(
			'http://localhost:4100/auth/github/start?callback=http://localhost:3100/oauth/callback',
		);
		const githubUrl = new URL(startRes.headers.get('Location')!);
		const signedState = githubUrl.searchParams.get('state')!;

		// First callback succeeds
		const first = await app.request(
			`http://localhost:4100/auth/github/callback?code=code&state=${encodeURIComponent(signedState)}`,
		);
		expect(first.status).toBe(302);
		const firstUrl = new URL(first.headers.get('Location')!);
		expect(firstUrl.searchParams.get('access_token')).toBe('gho_token');

		// Second callback with same state fails (nonce consumed)
		const second = await app.request(
			`http://localhost:4100/auth/github/callback?code=code&state=${encodeURIComponent(signedState)}`,
		);
		expect(second.status).toBe(302);
		const secondUrl = new URL(second.headers.get('Location')!);
		expect(secondUrl.searchParams.get('error')).toBe('expired_nonce');
	});
});
