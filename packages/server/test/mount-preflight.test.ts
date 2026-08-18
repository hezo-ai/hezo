import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetRuntimeConfig, setRuntimeConfig } from '../src/config/runtime';
import { DEFAULT_CONFIG } from '../src/config/types';
import type { DockerClient } from '../src/services/docker';
import {
	buildMountProbeScript,
	CONTAINER_RUNTIMES_DOCS_URL,
	checkContainerMounts,
	classifyMount,
	formatMountPreflightMessage,
	type MountProbeResult,
	parseMountProbeOutput,
} from '../src/services/mount-preflight';
import { createStubDocker } from './helpers/app';

const DATA_DIR = '/home/tester/.hezo';

describe('classifyMount', () => {
	const result = (over: Partial<MountProbeResult> = {}): MountProbeResult => ({
		sentinelSeen: true,
		writeSucceeded: true,
		hostSawWrite: true,
		...over,
	});

	it('reports ok when the mount is shared and writes reach the host', () => {
		expect(classifyMount(result())).toBe('ok');
	});

	it('reports read-only when the host directory is visible but not writable', () => {
		expect(classifyMount(result({ writeSucceeded: false }))).toBe('read-only');
	});

	it('reports not-mounted when the container cannot see the host directory', () => {
		expect(classifyMount(result({ sentinelSeen: false }))).toBe('not-mounted');
	});

	it('reports not-mounted when a "successful" write never reaches the host', () => {
		// The write landed in the container's own layer, not the bind mount - the
		// same practical failure as the path not being shared at all.
		expect(classifyMount(result({ hostSawWrite: false }))).toBe('not-mounted');
	});

	it('treats a missing sentinel as not-mounted even when the write appears to work', () => {
		expect(classifyMount(result({ sentinelSeen: false, hostSawWrite: true }))).toBe('not-mounted');
	});
});

describe('parseMountProbeOutput', () => {
	it('accepts only the exact sentinel the host wrote', () => {
		expect(parseMountProbeOutput('SEEN:abc123 WRITE:OK\n', 'abc123')).toEqual({
			sentinelSeen: true,
			writeSucceeded: true,
		});
		// A different token means the container is looking at someone else's dir.
		expect(parseMountProbeOutput('SEEN:other WRITE:OK\n', 'abc123').sentinelSeen).toBe(false);
	});

	it('reads the missing-file marker as not seen', () => {
		expect(parseMountProbeOutput('SEEN:- WRITE:OK\n', 'abc123')).toEqual({
			sentinelSeen: false,
			writeSucceeded: true,
		});
	});

	it('reads a failed write', () => {
		expect(parseMountProbeOutput('SEEN:abc123 WRITE:FAIL\n', 'abc123')).toEqual({
			sentinelSeen: true,
			writeSucceeded: false,
		});
	});

	it('treats unparseable output as a total failure rather than a pass', () => {
		expect(parseMountProbeOutput('', 'abc123')).toEqual({
			sentinelSeen: false,
			writeSucceeded: false,
		});
	});
});

describe('buildMountProbeScript', () => {
	it('reads the sentinel and attempts a write inside the mount', () => {
		const script = buildMountProbeScript('written-abc');
		expect(script).toContain('/mnt/hezo-mount-check/sentinel');
		expect(script).toContain('touch /mnt/hezo-mount-check/written-abc');
		expect(script).toContain('SEEN:%s WRITE:%s');
	});
});

describe('formatMountPreflightMessage', () => {
	it('names the read-only case and the Colima fix with the real data dir', () => {
		const msg = formatMountPreflightMessage('read-only', { dataDir: DATA_DIR });
		expect(msg).toContain('READ-ONLY');
		expect(msg).toContain(DATA_DIR);
		expect(msg).toContain(`colima start --mount ${DATA_DIR}:w`);
	});

	it('names the unshared case distinctly', () => {
		const msg = formatMountPreflightMessage('not-mounted', { dataDir: DATA_DIR });
		expect(msg).toContain('cannot see the Hezo data directory');
	});

	it('covers the other VM-backed runtimes and native-host permissions', () => {
		const msg = formatMountPreflightMessage('read-only', { dataDir: DATA_DIR });
		for (const runtime of ['Lima', 'Rancher Desktop', 'Docker Desktop']) {
			expect(msg).toContain(runtime);
		}
		expect(msg).toContain('SELinux');
		expect(msg).toContain(CONTAINER_RUNTIMES_DOCS_URL);
	});

	it('explains the impact so the message is actionable, not just alarming', () => {
		for (const outcome of ['read-only', 'not-mounted'] as const) {
			const msg = formatMountPreflightMessage(outcome, { dataDir: DATA_DIR });
			expect(msg).toContain('every agent run fails on its first write');
		}
	});

	it('never leaks the escape hatches to users', () => {
		for (const outcome of ['read-only', 'not-mounted'] as const) {
			const msg = formatMountPreflightMessage(outcome, { dataDir: DATA_DIR });
			expect(msg).not.toContain('HEZO_SKIP_DOCKER');
			// The opt-out suppresses the diagnosis; it does not fix the mount, so the
			// failure guidance must never offer it.
			expect(msg).not.toContain('skipMountCheck');
		}
	});

	it('uses hyphens, never em or en dashes (user-facing prose rule)', () => {
		for (const outcome of ['read-only', 'not-mounted'] as const) {
			expect(formatMountPreflightMessage(outcome, { dataDir: DATA_DIR })).not.toMatch(/[–—]/);
		}
	});
});

describe('checkContainerMounts', () => {
	let dataDir: string;
	const docker = createStubDocker() as DockerClient;

	beforeEach(() => {
		dataDir = mkdtempSync(join(tmpdir(), 'hezo-mount-check-'));
	});
	afterEach(() => {
		rmSync(dataDir, { recursive: true, force: true });
	});

	const check = (probe: () => Promise<MountProbeResult>, env: NodeJS.ProcessEnv = {}) =>
		checkContainerMounts({ docker, dataDir, probe, env, logOutcome: false });

	it('reports each outcome from the probe', async () => {
		const cases: Array<[Partial<MountProbeResult>, string]> = [
			[{}, 'ok'],
			[{ writeSucceeded: false }, 'read-only'],
			[{ sentinelSeen: false }, 'not-mounted'],
		];
		for (const [over, expected] of cases) {
			const outcome = await check(async () => ({
				sentinelSeen: true,
				writeSucceeded: true,
				hostSawWrite: true,
				...over,
			}));
			expect(outcome).toBe(expected);
		}
	});

	it('skips under the fake-docker env var without probing', async () => {
		let probed = false;
		const outcome = await check(
			async () => {
				probed = true;
				throw new Error('should not run');
			},
			{ HEZO_SKIP_DOCKER: '1' },
		);
		expect(outcome).toBe('skipped');
		expect(probed).toBe(false);
	});

	it('skips under the containers.skipMountCheck config key without probing', async () => {
		setRuntimeConfig({
			...DEFAULT_CONFIG,
			containers: { ...DEFAULT_CONFIG.containers, skipMountCheck: true },
		});
		try {
			let probed = false;
			const outcome = await check(async () => {
				probed = true;
				throw new Error('should not run');
			}, {});
			expect(outcome).toBe('skipped');
			expect(probed).toBe(false);
		} finally {
			resetRuntimeConfig();
		}
	});

	it('never throws when the probe machinery fails - diagnostics must not break startup', async () => {
		const outcome = await check(async () => {
			throw new Error('daemon hiccup');
		});
		expect(outcome).toBe('skipped');
	});

	it('leaves no scratch directory behind in the data dir', async () => {
		await check(async () => ({ sentinelSeen: true, writeSucceeded: true, hostSawWrite: true }));
		expect(readdirSync(dataDir)).toEqual([]);
		expect(existsSync(dataDir)).toBe(true);
	});
});
