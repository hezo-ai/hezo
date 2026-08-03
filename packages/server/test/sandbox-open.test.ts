import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { redactSandboxApiUrl } from '../src/lib/sandbox-backend-info';
import { DockerClient } from '../src/services/docker';
import { DOCKER_INSTALL_URL } from '../src/services/docker-preflight';
import { DaytonaClient } from '../src/services/sandbox/daytona/client';
import { DaytonaEngine } from '../src/services/sandbox/daytona/engine';
import { SandboxBackendError } from '../src/services/sandbox/errors';
import { openSandboxBackend } from '../src/services/sandbox/open';

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

/** Never retry in tests - the real backoff would add 6s per failing case. */
const NO_RETRY = { retryDelaysMs: [] };

/** A daemon that answers, so the Docker branch is exercised without one running. */
function dockerAnswers(): void {
	vi.spyOn(DockerClient.prototype, 'ping').mockResolvedValue(true);
}

describe('openSandboxBackend selection', () => {
	it('defaults to local Docker when nothing is configured', async () => {
		dockerAnswers();
		const { engine, info } = await openSandboxBackend(NO_RETRY);
		expect(engine).toBeInstanceOf(DockerClient);
		expect(info).toEqual({ backend: 'docker', display: 'local Docker daemon' });
	});

	it('accepts an explicit docker backend', async () => {
		dockerAnswers();
		const { engine } = await openSandboxBackend({ backend: 'docker', ...NO_RETRY });
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
		// Points at the credential, which is what an unreachable API most often
		// means. It used to say "drop --sandbox-backend to run on local Docker",
		// which is false once the backend is a stored setting the flag only seeds -
		// following it left the operator with the same failure.
		expect(err.message).toContain('--daytona-api-key');
		expect(err.message).toContain('Settings -> Containers');
		expect(err.message).not.toContain('drop --sandbox-backend');
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

/**
 * Docker gets a real preflight here, and this is the only place it gets one.
 *
 * The gate that used to sit at the top of `index.ts` ran before the database was
 * open, so it could only read the launch flag while the stored setting is what
 * actually selects the backend - an instance switched to Daytona from the
 * Containers page exited 1 on restart, showing Docker install guidance for a
 * backend it would never use. Moving the check here also gives the **runtime
 * switch** a preflight it never had: `switchSandboxBackend` destroys every
 * container before swapping, so a destination that cannot be reached has to be
 * caught before anything is torn down.
 */
describe('openSandboxBackend preflights Docker', () => {
	/** A PATH with, or without, a `docker` executable on it. */
	function pathWithDocker(present: boolean): string {
		const dir = mkdtempSync(join(tmpdir(), 'hezo-sandbox-open-'));
		if (present) {
			const bin = join(dir, process.platform === 'win32' ? 'docker.exe' : 'docker');
			writeFileSync(bin, '#!/bin/sh\necho docker\n');
			chmodSync(bin, 0o755);
		}
		return dir;
	}

	it('refuses rather than handing back an unpinged client', async () => {
		vi.spyOn(DockerClient.prototype, 'ping').mockResolvedValue(false);
		const result = await openSandboxBackend({ backend: 'docker', ...NO_RETRY }).catch(() => null);
		expect(result).toBeNull();
	});

	it('retries a daemon that is briefly restarting before giving up', async () => {
		// Docker Desktop bouncing for a couple of seconds must not kill startup -
		// the same allowance Daytona gets.
		const ping = vi
			.spyOn(DockerClient.prototype, 'ping')
			.mockResolvedValueOnce(false)
			.mockResolvedValue(true);
		const { engine } = await openSandboxBackend({ backend: 'docker', retryDelaysMs: [1] });
		expect(ping).toHaveBeenCalledTimes(2);
		expect(engine).toBeInstanceOf(DockerClient);
	});

	it('points at the install page when the daemon is down and docker is absent', async () => {
		// The distinction is the whole value of the message: "install it" and
		// "start it" are different actions, and a generic "cannot reach" is neither.
		vi.spyOn(DockerClient.prototype, 'ping').mockResolvedValue(false);
		const dir = pathWithDocker(false);
		try {
			vi.stubEnv('PATH', dir);
			const err = await openSandboxBackend({ backend: 'docker', ...NO_RETRY }).catch((e) => e);
			expect(err).toBeInstanceOf(SandboxBackendError);
			expect(err.message).toContain('not appear to be installed');
			expect(err.message).toContain(DOCKER_INSTALL_URL);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('explains how to start the daemon when docker is installed but down', async () => {
		vi.spyOn(DockerClient.prototype, 'ping').mockResolvedValue(false);
		const dir = pathWithDocker(true);
		try {
			vi.stubEnv('PATH', dir);
			const err = await openSandboxBackend({ backend: 'docker', ...NO_RETRY }).catch((e) => e);
			expect(err.message).toContain('daemon is not reachable');
			expect(err.message).not.toContain('not appear to be installed');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('offers the managed backend as the alternative to a local daemon', async () => {
		// An operator with no Docker is not stuck: the other backend is the reason
		// this seam exists, and the failure is where they will look for it.
		vi.spyOn(DockerClient.prototype, 'ping').mockResolvedValue(false);
		const err = await openSandboxBackend({ backend: 'docker', ...NO_RETRY }).catch((e) => e);
		expect(err.message).toContain('--sandbox-backend');
		expect(err.message).toContain('HEZO_SANDBOX_BACKEND');
	});

	it('never surfaces the test-only escape hatch to an operator', async () => {
		vi.spyOn(DockerClient.prototype, 'ping').mockResolvedValue(false);
		const err = await openSandboxBackend({ backend: 'docker', ...NO_RETRY }).catch((e) => e);
		expect(err.message).not.toContain('HEZO_SKIP_DOCKER');
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
