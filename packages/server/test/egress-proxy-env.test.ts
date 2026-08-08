import { describe, expect, it } from 'vitest';
import { buildEgressProxyEnv } from '../src/services/egress';

/**
 * The entries that decide whether an in-container request reaches the egress
 * proxy at all - and therefore whether a `__HEZO_SECRET_<NAME>__` placeholder
 * ever becomes a real credential.
 *
 * Shared rather than inline because being inline is exactly how the bug
 * happened: only the agent CLI's env carried them, so every in-container git
 * op connected direct and shipped the placeholder as its password.
 */
describe('buildEgressProxyEnv', () => {
	const endpoint = { host: '127.0.0.1', port: 21000, token: 'run-token' };

	it('emits both spellings of every variable', () => {
		const env = buildEgressProxyEnv(endpoint);
		const url = 'http://run:run-token@127.0.0.1:21000';
		// Clients disagree about which casing they read, so neither is optional.
		expect(env).toContain(`HTTP_PROXY=${url}`);
		expect(env).toContain(`http_proxy=${url}`);
		expect(env).toContain(`HTTPS_PROXY=${url}`);
		expect(env).toContain(`https_proxy=${url}`);
		expect(env.filter((e) => e.startsWith('NO_PROXY=')).length).toBe(1);
		expect(env.filter((e) => e.startsWith('no_proxy=')).length).toBe(1);
	});

	it('carries the per-run token as userinfo, so clients send Proxy-Authorization', () => {
		const url = new URL(
			buildEgressProxyEnv(endpoint)
				.find((e) => e.startsWith('HTTPS_PROXY='))
				?.slice('HTTPS_PROXY='.length) as string,
		);
		expect(url.username).toBe('run');
		expect(url.password).toBe('run-token');
	});

	it('degrades to a bare URL when proxy auth is disabled', () => {
		const env = buildEgressProxyEnv({ ...endpoint, token: null });
		expect(env).toContain('HTTPS_PROXY=http://127.0.0.1:21000');
	});

	it('exempts the proxy host and container loopback by default', () => {
		const noProxy = buildEgressProxyEnv({ ...endpoint, host: '10.0.0.5' })
			.find((e) => e.startsWith('NO_PROXY='))
			?.split('=')[1]
			.split(',');
		expect(noProxy).toContain('10.0.0.5');
		expect(noProxy).toContain('localhost');
		expect(noProxy).toContain('127.0.0.1');
	});

	it('appends caller-supplied direct hosts and de-duplicates', () => {
		const noProxy = buildEgressProxyEnv(endpoint, ['api.example.com', '127.0.0.1'])
			.find((e) => e.startsWith('NO_PROXY='))
			?.split('=')[1]
			.split(',');
		expect(noProxy).toContain('api.example.com');
		// `127.0.0.1` is already a default; a caller repeating it must not double it.
		expect(noProxy?.filter((h) => h === '127.0.0.1').length).toBe(1);
	});

	it('exempts nothing beyond the defaults when the caller passes no direct hosts', () => {
		// A model-provider upstream is the one thing allowed to bypass the proxy
		// (AGENTS.md red line, sole exception); a git or provisioning caller has no
		// such exemption and must not inherit one.
		const noProxy = buildEgressProxyEnv(endpoint)
			.find((e) => e.startsWith('NO_PROXY='))
			?.split('=')[1]
			.split(',');
		expect(noProxy).toEqual(['127.0.0.1', 'localhost']);
	});
});
