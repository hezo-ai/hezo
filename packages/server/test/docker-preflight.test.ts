import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	checkDockerAvailability,
	DOCKER_INSTALL_URL,
	dockerBinaryOnPath,
	evaluateDockerPreflight,
	formatDockerPreflightMessage,
} from '../src/services/docker-preflight';

describe('checkDockerAvailability', () => {
	it('reports ok when the daemon answers a ping (binary probe not consulted)', async () => {
		let binaryProbed = false;
		const result = await checkDockerAvailability({
			ping: async () => true,
			binaryInstalled: () => {
				binaryProbed = true;
				return false;
			},
		});
		expect(result).toBe('ok');
		// A reachable daemon is sufficient — we never need to ask whether the CLI exists.
		expect(binaryProbed).toBe(false);
	});

	it('reports not-running when the ping fails but the binary is installed', async () => {
		const result = await checkDockerAvailability({
			ping: async () => false,
			binaryInstalled: () => true,
		});
		expect(result).toBe('not-running');
	});

	it('reports not-installed when the ping fails and no binary is present', async () => {
		const result = await checkDockerAvailability({
			ping: async () => false,
			binaryInstalled: () => false,
		});
		expect(result).toBe('not-installed');
	});

	it('awaits an async binary probe', async () => {
		const result = await checkDockerAvailability({
			ping: async () => false,
			binaryInstalled: async () => true,
		});
		expect(result).toBe('not-running');
	});
});

describe('dockerBinaryOnPath', () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'hezo-docker-preflight-'));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('finds a docker executable on PATH', () => {
		const bin = join(dir, process.platform === 'win32' ? 'docker.exe' : 'docker');
		writeFileSync(bin, '#!/bin/sh\necho docker\n');
		chmodSync(bin, 0o755);
		expect(dockerBinaryOnPath({ PATH: dir })).toBe(true);
	});

	it('returns false when no docker executable is on PATH', () => {
		expect(dockerBinaryOnPath({ PATH: dir })).toBe(false);
	});

	it('returns false for an empty PATH', () => {
		expect(dockerBinaryOnPath({ PATH: '' })).toBe(false);
		expect(dockerBinaryOnPath({})).toBe(false);
	});
});

describe('evaluateDockerPreflight', () => {
	it('returns ok when the docker client pings successfully', async () => {
		const result = await evaluateDockerPreflight({ ping: async () => true }, { PATH: '' });
		expect(result).toBe('ok');
	});

	it('returns not-installed when the daemon is down and docker is absent from PATH', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'hezo-docker-preflight-'));
		try {
			const result = await evaluateDockerPreflight({ ping: async () => false }, { PATH: dir });
			expect(result).toBe('not-installed');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('returns not-running when the daemon is down but docker is on PATH', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'hezo-docker-preflight-'));
		try {
			const bin = join(dir, process.platform === 'win32' ? 'docker.exe' : 'docker');
			writeFileSync(bin, '#!/bin/sh\necho docker\n');
			chmodSync(bin, 0o755);
			const result = await evaluateDockerPreflight({ ping: async () => false }, { PATH: dir });
			expect(result).toBe('not-running');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('formatDockerPreflightMessage', () => {
	it('points at the Docker install page when not installed', () => {
		const msg = formatDockerPreflightMessage('not-installed');
		expect(msg).toContain(DOCKER_INSTALL_URL);
		expect(msg).toContain('not appear to be installed');
		expect(msg).toContain('HEZO_SKIP_DOCKER');
	});

	it('explains how to start the daemon when not running', () => {
		const msg = formatDockerPreflightMessage('not-running');
		expect(msg).toContain('daemon is not reachable');
		expect(msg).toContain('Start Docker');
		expect(msg).toContain(DOCKER_INSTALL_URL);
	});

	it('explains the security rationale (isolation / host protection) in both variants', () => {
		for (const status of ['not-installed', 'not-running'] as const) {
			const msg = formatDockerPreflightMessage(status);
			expect(msg).toContain('isolated Docker containers');
			expect(msg).toContain('security boundary');
			expect(msg).toContain('host');
		}
	});
});
