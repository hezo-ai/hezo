import type { DeviceAuthConfig } from '@hezo/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
	pollDeviceFlow,
	resolveDeviceAuth,
	startDeviceFlow,
} from '../src/services/oauth/device-flow';

const cfg: DeviceAuthConfig = {
	deviceCodeUrl: 'https://github.com/login/device/code',
	tokenUrl: 'https://github.com/login/oauth/access_token',
	clientIdEnv: 'TEST_DEVICE_CLIENT_ID',
	clientIdDefault: 'public-dev-id',
	baseUrlEnv: 'TEST_DEVICE_BASE_URL',
};

afterEach(() => {
	delete process.env.TEST_DEVICE_CLIENT_ID;
	delete process.env.TEST_DEVICE_BASE_URL;
});

describe('resolveDeviceAuth', () => {
	it('falls back to the committed dev client_id outside production', () => {
		const r = resolveDeviceAuth(cfg);
		expect(r.clientId).toBe('public-dev-id');
		expect(r.deviceCodeUrl).toBe('https://github.com/login/device/code');
		expect(r.tokenUrl).toBe('https://github.com/login/oauth/access_token');
	});

	it('prefers the env client_id override', () => {
		process.env.TEST_DEVICE_CLIENT_ID = 'env-id';
		expect(resolveDeviceAuth(cfg).clientId).toBe('env-id');
	});

	it('rewrites endpoint origins when the base-url override is set', () => {
		process.env.TEST_DEVICE_BASE_URL = 'http://localhost:9999';
		const r = resolveDeviceAuth(cfg);
		expect(r.deviceCodeUrl).toBe('http://localhost:9999/login/device/code');
		expect(r.tokenUrl).toBe('http://localhost:9999/login/oauth/access_token');
	});

	it('throws when no client_id is configured', () => {
		expect(() => resolveDeviceAuth({ ...cfg, clientIdDefault: undefined })).toThrow(
			/TEST_DEVICE_CLIENT_ID/,
		);
	});
});

describe('startDeviceFlow', () => {
	it('posts client_id + scopes and maps the response', async () => {
		let captured: { url: string; body: string } | null = null;
		const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
			captured = { url: String(input), body: String(init?.body) };
			return new Response(
				JSON.stringify({
					device_code: 'dc',
					user_code: 'UC-1',
					verification_uri: 'https://gh/device',
					expires_in: 900,
					interval: 5,
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			);
		};
		const start = await startDeviceFlow({
			deviceCodeUrl: 'https://gh/login/device/code',
			clientId: 'cid',
			scopes: ['repo', 'read:org'],
			fetchFn,
		});
		expect(start).toEqual({
			deviceCode: 'dc',
			userCode: 'UC-1',
			verificationUri: 'https://gh/device',
			expiresIn: 900,
			interval: 5,
		});
		expect(captured!.url).toBe('https://gh/login/device/code');
		expect(captured!.body).toContain('client_id=cid');
		expect(captured!.body).toContain('scope=repo+read%3Aorg');
	});

	it('throws on a non-ok device-code response', async () => {
		const fetchFn = async () => new Response('nope', { status: 422 });
		await expect(
			startDeviceFlow({ deviceCodeUrl: 'https://gh/x', clientId: 'c', scopes: [], fetchFn }),
		).rejects.toThrow(/422/);
	});
});

describe('pollDeviceFlow', () => {
	const poll = (body: unknown) =>
		pollDeviceFlow({
			tokenUrl: 'https://gh/token',
			clientId: 'c',
			deviceCode: 'dc',
			fetchFn: async () =>
				new Response(JSON.stringify(body), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				}),
		});

	it('maps authorization_pending to pending with the retry interval', async () => {
		expect(await poll({ error: 'authorization_pending', interval: 7 })).toEqual({
			status: 'pending',
			retryAfter: 7,
		});
	});

	it('maps slow_down to pending', async () => {
		expect((await poll({ error: 'slow_down' })).status).toBe('pending');
	});

	it('maps an access token to success (public client: no refresh/expiry)', async () => {
		expect(await poll({ access_token: 'gho_x', scope: 'repo read:org' })).toEqual({
			status: 'success',
			accessToken: 'gho_x',
			scope: 'repo read:org',
			refreshToken: null,
			expiresAt: null,
		});
	});

	it('captures the refresh token and derives expiry when the provider issues them', async () => {
		const before = Date.now();
		const result = await poll({
			access_token: 'ya29.access',
			refresh_token: '1//refresh',
			scope: 'https://www.googleapis.com/auth/youtube',
			expires_in: 3600,
		});
		if (result.status !== 'success') throw new Error(`expected success, got ${result.status}`);
		expect(result.accessToken).toBe('ya29.access');
		expect(result.refreshToken).toBe('1//refresh');
		expect(result.expiresAt).toBeInstanceOf(Date);
		// ~1h out (allow slack for test execution time).
		expect(result.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 3600 * 1000);
		expect(result.expiresAt!.getTime()).toBeLessThan(before + 3600 * 1000 + 60_000);
	});

	it('sends client_secret in the token poll for a confidential (Google) client', async () => {
		let capturedBody = '';
		const result = await pollDeviceFlow({
			tokenUrl: 'https://oauth2.googleapis.com/token',
			clientId: 'gcid.apps.googleusercontent.com',
			clientSecret: 'GOCSPX-secret',
			deviceCode: 'dc',
			fetchFn: async (_input, init) => {
				capturedBody = String(init?.body);
				return new Response(JSON.stringify({ access_token: 'ya29.x', expires_in: 3599 }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			},
		});
		expect(result.status).toBe('success');
		expect(capturedBody).toContain('client_secret=GOCSPX-secret');
		expect(capturedBody).toContain(
			'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code',
		);
	});

	it('omits client_secret for a public client', async () => {
		let capturedBody = '';
		await pollDeviceFlow({
			tokenUrl: 'https://gh/token',
			clientId: 'c',
			deviceCode: 'dc',
			fetchFn: async (_input, init) => {
				capturedBody = String(init?.body);
				return new Response(JSON.stringify({ access_token: 'gho_x' }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			},
		});
		expect(capturedBody).not.toContain('client_secret');
	});

	it('maps any other error to failed', async () => {
		expect(await poll({ error: 'access_denied' })).toEqual({
			status: 'failed',
			error: 'access_denied',
		});
	});
});
