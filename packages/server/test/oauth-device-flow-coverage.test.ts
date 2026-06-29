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
	delete process.env.NODE_ENV;
});

describe('resolveDeviceAuth — production / no-base branches', () => {
	it('ignores the committed dev default in production (env var unset → throws)', () => {
		process.env.NODE_ENV = 'production';
		// In production the clientIdDefault fallback is suppressed, so an unset
		// env var yields an empty client_id and the explicit throw fires.
		expect(() => resolveDeviceAuth(cfg)).toThrow(/TEST_DEVICE_CLIENT_ID/);
	});

	it('uses the env client_id in production when present', () => {
		process.env.NODE_ENV = 'production';
		process.env.TEST_DEVICE_CLIENT_ID = 'prod-id';
		expect(resolveDeviceAuth(cfg).clientId).toBe('prod-id');
	});

	it('leaves URLs untouched when no baseUrlEnv is configured', () => {
		const noBase: DeviceAuthConfig = { ...cfg, baseUrlEnv: undefined };
		const r = resolveDeviceAuth(noBase);
		expect(r.deviceCodeUrl).toBe(cfg.deviceCodeUrl);
		expect(r.tokenUrl).toBe(cfg.tokenUrl);
	});

	it('leaves URLs untouched when baseUrlEnv is set but the env var is empty', () => {
		// baseOverride resolves to undefined → applyBase returns the url unchanged.
		const r = resolveDeviceAuth(cfg);
		expect(r.deviceCodeUrl).toBe(cfg.deviceCodeUrl);
	});
});

describe('pollDeviceFlow — default-value branches', () => {
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

	it('defaults retryAfter to 5 when the pending response omits interval', async () => {
		expect(await poll({ error: 'authorization_pending' })).toEqual({
			status: 'pending',
			retryAfter: 5,
		});
	});

	it('defaults scope to empty string when success omits scope', async () => {
		expect(await poll({ access_token: 'gho_x' })).toEqual({
			status: 'success',
			accessToken: 'gho_x',
			scope: '',
		});
	});

	it('maps a body with neither token nor error to failed/unknown_error', async () => {
		expect(await poll({})).toEqual({ status: 'failed', error: 'unknown_error' });
	});
});

describe('startDeviceFlow — empty-scope request body', () => {
	it('joins an empty scopes array into an empty scope param', async () => {
		let capturedBody = '';
		const fetchFn = async (_input: string | URL | Request, init?: RequestInit) => {
			capturedBody = String(init?.body);
			return new Response(
				JSON.stringify({
					device_code: 'dc',
					user_code: 'UC',
					verification_uri: 'https://gh/device',
					expires_in: 600,
					interval: 5,
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			);
		};
		await startDeviceFlow({
			deviceCodeUrl: 'https://gh/x',
			clientId: 'cid',
			scopes: [],
			fetchFn,
		});
		expect(capturedBody).toContain('scope=');
		expect(capturedBody).toContain('client_id=cid');
	});
});
