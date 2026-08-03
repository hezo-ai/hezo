import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	CONTAINER_RUNTIMES_DOCS_URL,
	checkDockerAvailability,
	DOCKER_INSTALL_URL,
	dockerBinaryOnPath,
	evaluateDockerPreflight,
	formatDockerPreflightMessage,
} from '../src/services/docker-preflight';
import {
	type DockerSocketCandidate,
	getResolvedDockerSocket,
	setResolvedDockerSocket,
} from '../src/services/docker-socket';

/** A PATH containing a fake `docker` executable, so the binary probe says "installed". */
function pathWithDockerBinary(dir: string): string {
	const bin = join(dir, process.platform === 'win32' ? 'docker.exe' : 'docker');
	writeFileSync(bin, '#!/bin/sh\necho docker\n');
	chmodSync(bin, 0o755);
	return dir;
}

const NO_RUNTIME_ENV = { HOME: '/nonexistent-home', PATH: '' };

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
		expect(dockerBinaryOnPath({ PATH: pathWithDockerBinary(dir) })).toBe(true);
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
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'hezo-docker-preflight-'));
		setResolvedDockerSocket(null);
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		setResolvedDockerSocket(null);
	});

	it('returns ok and records the socket that answered', async () => {
		const result = await evaluateDockerPreflight({
			override: '/tmp/hezo-preflight.sock',
			env: NO_RUNTIME_ENV,
			ping: async () => true,
		});
		expect(result.status).toBe('ok');
		expect(result.socket).toEqual({ path: '/tmp/hezo-preflight.sock', source: 'flag' });
		// Recorded globally so every DockerClient uses the socket that actually works.
		expect(getResolvedDockerSocket()?.path).toBe('/tmp/hezo-preflight.sock');
	});

	it('walks past a dead socket to the one that answers, then stops', async () => {
		// A real Colima home with two profiles: `default` is dead, `work` answers.
		const home = mkdtempSync(join(tmpdir(), 'hezo-preflight-home-'));
		const dead = join(home, '.colima', 'default', 'docker.sock');
		const live = join(home, '.colima', 'work', 'docker.sock');
		try {
			for (const sock of [dead, live]) {
				mkdirSync(dirname(sock), { recursive: true });
				writeFileSync(sock, '');
			}
			const probed: string[] = [];
			const result = await evaluateDockerPreflight({
				env: { HOME: home, PATH: '' },
				ping: async (p) => {
					probed.push(p);
					return p === live;
				},
			});
			expect(result.status).toBe('ok');
			expect(result.socket).toEqual({ path: live, source: 'discovered', runtime: 'colima' });
			// `default` is probed first, then `work`; nothing after the hit.
			expect(probed.filter((p) => p.startsWith(home))).toEqual([dead, live]);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it('returns not-installed when nothing answers and docker is absent from PATH', async () => {
		const result = await evaluateDockerPreflight({
			override: '/tmp/hezo-missing.sock',
			env: { HOME: '/nonexistent-home', PATH: dir },
			ping: async () => false,
		});
		expect(result.status).toBe('not-installed');
		expect(result.tried.map((c) => c.path)).toEqual(['/tmp/hezo-missing.sock']);
	});

	it('returns not-running when nothing answers but docker is on PATH', async () => {
		const result = await evaluateDockerPreflight({
			override: '/tmp/hezo-missing.sock',
			env: { HOME: '/nonexistent-home', PATH: pathWithDockerBinary(dir) },
			ping: async () => false,
		});
		expect(result.status).toBe('not-running');
	});

	it('reports an unsupported DOCKER_HOST transport without probing anything', async () => {
		let pinged = false;
		const result = await evaluateDockerPreflight({
			env: { ...NO_RUNTIME_ENV, DOCKER_HOST: 'tcp://localhost:2375' },
			ping: async () => {
				pinged = true;
				return true;
			},
		});
		expect(result.status).toBe('unsupported-docker-host');
		expect(result.unsupported).toEqual({
			scheme: 'tcp',
			source: 'docker-host',
			value: 'tcp://localhost:2375',
		});
		expect(pinged).toBe(false);
	});
});

describe('formatDockerPreflightMessage', () => {
	const tried: DockerSocketCandidate[] = [
		{ path: '/var/run/docker.sock', source: 'discovered', runtime: 'docker-engine' },
		{ path: '/home/tester/.colima/default/docker.sock', source: 'discovered', runtime: 'colima' },
	];
	const notRunning = { status: 'not-running' as const, tried };
	const notInstalled = { status: 'not-installed' as const, tried: [] };
	const unsupported = {
		status: 'unsupported-docker-host' as const,
		tried: [],
		unsupported: { scheme: 'tcp' as const, source: 'docker-host' as const, value: 'tcp://x:2375' },
	};

	it('points at the Docker install page when nothing is installed', () => {
		const msg = formatDockerPreflightMessage(notInstalled);
		expect(msg).toContain(DOCKER_INSTALL_URL);
		expect(msg).toContain('A Docker-compatible container runtime is required');
	});

	it('names the Docker-compatible runtimes rather than assuming Docker Desktop', () => {
		const msg = formatDockerPreflightMessage(notRunning);
		for (const runtime of ['Docker Desktop', 'Colima', 'Rancher Desktop', 'OrbStack']) {
			expect(msg).toContain(runtime);
		}
		expect(msg).toContain('colima start');
		expect(msg).toContain('sudo systemctl start docker');
	});

	it('lists the sockets it probed, so the operator can see where Hezo looked', () => {
		const msg = formatDockerPreflightMessage(notRunning, '/home/tester');
		expect(msg).toContain('Sockets tried:');
		expect(msg).toContain('/var/run/docker.sock');
		// Home-relative paths are collapsed for readability.
		expect(msg).toContain('~/.colima/default/docker.sock');
	});

	it('offers the explicit override when discovery came up empty', () => {
		const msg = formatDockerPreflightMessage(notRunning);
		expect(msg).toContain('--docker-socket');
		expect(msg).toContain('HEZO_DOCKER_SOCKET');
	});

	it('explains an unsupported transport and how to point at a socket instead', () => {
		const msg = formatDockerPreflightMessage(unsupported);
		expect(msg).toContain('DOCKER_HOST');
		expect(msg).toContain('tcp:// endpoint');
		expect(msg).toContain('Unix socket');
		expect(msg).toContain('--docker-socket');
	});

	it('links the supported-runtime docs from every failure', () => {
		for (const result of [notInstalled, notRunning, unsupported]) {
			expect(formatDockerPreflightMessage(result)).toContain(CONTAINER_RUNTIMES_DOCS_URL);
		}
	});

	it('explains the security rationale (isolation / host protection) in every variant', () => {
		for (const result of [notInstalled, notRunning, unsupported]) {
			const msg = formatDockerPreflightMessage(result);
			expect(msg).toContain('isolated Docker containers');
			expect(msg).toContain('security boundary');
			expect(msg).toContain('host');
		}
	});

	it('never leaks the test-only HEZO_SKIP_DOCKER escape hatch to users', () => {
		for (const result of [notInstalled, notRunning, unsupported]) {
			expect(formatDockerPreflightMessage(result)).not.toContain('HEZO_SKIP_DOCKER');
		}
	});

	it('uses hyphens, never em or en dashes (user-facing prose rule)', () => {
		for (const result of [notInstalled, notRunning, unsupported]) {
			expect(formatDockerPreflightMessage(result)).not.toMatch(/[–—]/);
		}
	});
});
