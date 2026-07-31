import { afterEach, describe, expect, it, vi } from 'vitest';
import { redactSandboxApiUrl } from '../src/lib/sandbox-backend-info';
import { DockerClient } from '../src/services/docker';
import { DaytonaClient } from '../src/services/sandbox/daytona/client';
import { DaytonaEngine } from '../src/services/sandbox/daytona/engine';
import { SandboxBackendError } from '../src/services/sandbox/errors';
import { openSandboxBackend } from '../src/services/sandbox/open';

afterEach(() => {
	vi.restoreAllMocks();
});

/** Never retry in tests - the real backoff would add 6s per failing case. */
const NO_RETRY = { retryDelaysMs: [] };

describe('openSandboxBackend selection', () => {
	it('defaults to local Docker when nothing is configured', async () => {
		const { engine, info } = await openSandboxBackend();
		expect(engine).toBeInstanceOf(DockerClient);
		expect(info).toEqual({ backend: 'docker', display: 'local Docker daemon' });
	});

	it('accepts an explicit docker backend', async () => {
		const { engine } = await openSandboxBackend({ backend: 'docker' });
		expect(engine).toBeInstanceOf(DockerClient);
	});

	it('rejects an unknown backend by name rather than falling back', async () => {
		// Silently treating a typo as "docker" would run every agent somewhere the
		// operator did not choose, which is the whole failure this guards.
		await expect(openSandboxBackend({ backend: 'daytonaa' })).rejects.toThrow(SandboxBackendError);
		await expect(openSandboxBackend({ backend: 'daytonaa' })).rejects.toThrow(/docker, daytona/);
	});

	it('opens the Daytona engine when the preflight passes', async () => {
		vi.spyOn(DaytonaClient.prototype, 'ping').mockResolvedValue(true);
		const { engine, info } = await openSandboxBackend({
			backend: 'daytona',
			daytonaApiKey: 'dtn_test',
			daytonaApiUrl: 'https://app.daytona.io/api',
			...NO_RETRY,
		});
		expect(engine).toBeInstanceOf(DaytonaEngine);
		expect(info.backend).toBe('daytona');
	});
});

/**
 * The rule these encode: a configured managed service never silently degrades
 * to the local one. An instance that fell back would look healthy while running
 * agents somewhere the operator did not choose, and the first symptom would be
 * an agent run failing for no visible reason.
 */
describe('openSandboxBackend is fatal, never degraded', () => {
	it('refuses to start when the backend is selected without a key', async () => {
		const err = await openSandboxBackend({ backend: 'daytona', ...NO_RETRY }).catch((e) => e);
		expect(err).toBeInstanceOf(SandboxBackendError);
		// Names the flag AND its env var, since a deployment may set either.
		expect(err.message).toContain('--daytona-api-key');
		expect(err.message).toContain('HEZO_DAYTONA_API_KEY');
	});

	it('reports a missing key before making any network call', async () => {
		// Otherwise the operator is sent to check connectivity for what is really
		// a configuration mistake.
		const ping = vi.spyOn(DaytonaClient.prototype, 'ping').mockResolvedValue(true);
		await openSandboxBackend({ backend: 'daytona', ...NO_RETRY }).catch(() => undefined);
		expect(ping).not.toHaveBeenCalled();
	});

	it('refuses to start when the API is unreachable', async () => {
		vi.spyOn(DaytonaClient.prototype, 'ping').mockResolvedValue(false);
		const err = await openSandboxBackend({
			backend: 'daytona',
			daytonaApiKey: 'dtn_test',
			...NO_RETRY,
		}).catch((e) => e);
		expect(err).toBeInstanceOf(SandboxBackendError);
		expect(err.message).toContain('--sandbox-backend');
	});

	it('never hands back a Docker engine on any failing path', async () => {
		// The assertion that actually proves there is no silent fallback.
		vi.spyOn(DaytonaClient.prototype, 'ping').mockResolvedValue(false);
		for (const opts of [
			{ backend: 'daytona' },
			{ backend: 'daytona', daytonaApiKey: 'dtn_test' },
			{ backend: 'nonsense' },
		]) {
			const result = await openSandboxBackend({ ...opts, ...NO_RETRY }).catch(() => null);
			expect(result).toBeNull();
		}
	});

	it('retries a briefly-unreachable endpoint before giving up', async () => {
		// A provider restarting for a few seconds should not kill startup.
		const ping = vi
			.spyOn(DaytonaClient.prototype, 'ping')
			.mockResolvedValueOnce(false)
			.mockResolvedValue(true);
		const { info } = await openSandboxBackend({
			backend: 'daytona',
			daytonaApiKey: 'dtn_test',
			retryDelaysMs: [1],
		});
		expect(ping).toHaveBeenCalledTimes(2);
		expect(info.backend).toBe('daytona');
	});

	it('never puts the API key in the error message', async () => {
		const key = 'dtn_super_secret_value';
		vi.spyOn(DaytonaClient.prototype, 'ping').mockResolvedValue(false);
		const err = await openSandboxBackend({
			backend: 'daytona',
			daytonaApiKey: key,
			daytonaApiUrl: 'https://app.daytona.io/api',
			...NO_RETRY,
		}).catch((e) => e);
		expect(err.message).not.toContain(key);
	});
});

describe('redactSandboxApiUrl', () => {
	it('keeps the endpoint identifiable', () => {
		expect(redactSandboxApiUrl('https://app.daytona.io/api')).toBe('https://app.daytona.io/api');
	});

	it('drops userinfo and query, either of which could carry a credential', () => {
		expect(redactSandboxApiUrl('https://user:pass@eu.daytona.io/api?token=abc')).toBe(
			'https://eu.daytona.io/api',
		);
	});

	it('fully occludes anything unparseable, rather than echoing a fragment', () => {
		// A malformed string may hold a key in an unknown layout.
		for (const raw of ['not a url', '', 'dtn_key_pasted_into_the_url_field']) {
			expect(redactSandboxApiUrl(raw)).toBe('••••');
		}
	});
});
