import { Logger } from '@hiddentao/logger';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	checkContainerToHostConnectivity,
	SKIP_CONNECTIVITY_ENV,
} from '../src/services/container-connectivity-preflight';
import { createStubDocker } from './helpers/app';

// These exercise the real runContainerProbe + startProbeListener path (no injected
// `probe`), which the existing suite always stubs out. The stub docker scripts the
// exec stdout so parseProbeOutput runs against a real probe round-trip.

describe('checkContainerToHostConnectivity — real container probe path', () => {
	let warnSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;
	let infoSpy: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
		errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
		infoSpy = vi.spyOn(Logger.prototype, 'info').mockImplementation(() => {});
	});
	afterEach(() => vi.restoreAllMocks());

	function probeDocker(stdout: string, opts: { removeThrows?: boolean } = {}) {
		const calls = { created: 0, started: 0, execed: 0, removed: 0 };
		const docker = createStubDocker({
			imageExists: async () => true,
			createContainer: async (name: string) => {
				calls.created++;
				expect(name).toMatch(/^hezo-connectivity-check-[0-9a-f]+$/);
				return { Id: `probe-${name}`, Warnings: [] };
			},
			startContainer: async () => {
				calls.started++;
			},
			execCreate: async () => {
				calls.execed++;
				return 'exec-probe';
			},
			execStart: async () => ({ stdout, stderr: '' }),
			removeContainer: async () => {
				calls.removed++;
				if (opts.removeThrows) throw new Error('remove boom');
			},
		});
		return { docker, calls };
	}

	const base = {
		serverPort: 3100,
		containerBindHost: '127.0.0.1',
		retryGapMs: 0,
		attempts: 1,
		env: {} as NodeJS.ProcessEnv,
	};

	it('boots a throwaway container, execs the probe, and classifies a fully-reachable result as ok', async () => {
		const { docker, calls } = probeDocker('MCP:200 BIND:200 GW:172.17.0.1\n');
		const result = await checkContainerToHostConnectivity({ ...base, docker });
		expect(result.outcome).toBe('ok');
		expect(result.gatewayIp).toBe('172.17.0.1');
		expect(calls.created).toBe(1);
		expect(calls.started).toBe(1);
		expect(calls.execed).toBe(1);
		// The container is always torn down in the finally block.
		expect(calls.removed).toBe(1);
		expect(warnSpy).not.toHaveBeenCalled();
		expect(errorSpy).not.toHaveBeenCalled();
	});

	it('classifies a loopback bind from the real probe and still tears the container down', async () => {
		const { docker, calls } = probeDocker('MCP:200 BIND:000 GW:-\n');
		const result = await checkContainerToHostConnectivity({ ...base, docker });
		expect(result.outcome).toBe('bind-loopback');
		expect(result.gatewayIp).toBeUndefined();
		expect(calls.removed).toBe(1);
		expect(warnSpy).toHaveBeenCalled();
	});

	it('classifies mcp-unreachable from the real probe at error', async () => {
		const { docker } = probeDocker('MCP:000 BIND:000 GW:-\n');
		const result = await checkContainerToHostConnectivity({ ...base, docker });
		expect(result.outcome).toBe('mcp-unreachable');
		expect(errorSpy).toHaveBeenCalled();
	});

	it('swallows a teardown failure (removeContainer throws) — warns but still returns the outcome', async () => {
		const { docker, calls } = probeDocker('MCP:200 BIND:200 GW:172.17.0.1\n', {
			removeThrows: true,
		});
		const result = await checkContainerToHostConnectivity({ ...base, docker });
		// The probe result is unaffected by the cleanup failure.
		expect(result.outcome).toBe('ok');
		expect(calls.removed).toBe(1);
		// The cleanup failure is logged at warn ("failed to remove ...").
		expect(warnSpy).toHaveBeenCalled();
	});

	it('retries the real probe across attempts before settling (transient then ok)', async () => {
		let n = 0;
		const docker = createStubDocker({
			imageExists: async () => true,
			createContainer: async (name: string) => ({ Id: `c-${name}`, Warnings: [] }),
			execCreate: async () => 'exec-retry',
			execStart: async () => {
				n++;
				return {
					stdout: n === 1 ? 'MCP:000 BIND:000 GW:-\n' : 'MCP:200 BIND:200 GW:172.17.0.1\n',
					stderr: '',
				};
			},
		});
		const result = await checkContainerToHostConnectivity({
			...base,
			attempts: 3,
			docker,
		});
		expect(result.outcome).toBe('ok');
		expect(n).toBe(2); // stopped retrying once ok
	});

	it('stays skipped (non-fatal) when ensureImage / createContainer throws in the real path', async () => {
		const docker = createStubDocker({
			imageExists: async () => true,
			createContainer: async () => {
				throw new Error('docker create failed');
			},
		});
		const result = await checkContainerToHostConnectivity({ ...base, docker });
		expect(result.outcome).toBe('skipped');
		// Probe-machinery failures stay quiet at info, never warn/error.
		expect(infoSpy).toHaveBeenCalled();
		expect(warnSpy).not.toHaveBeenCalled();
		expect(errorSpy).not.toHaveBeenCalled();
	});

	it('honours the opt-out env var without booting the real probe', async () => {
		const { docker, calls } = probeDocker('MCP:200 BIND:200 GW:172.17.0.1\n');
		const result = await checkContainerToHostConnectivity({
			...base,
			env: { [SKIP_CONNECTIVITY_ENV]: '1' },
			docker,
		});
		expect(result.outcome).toBe('skipped');
		expect(calls.created).toBe(0);
	});
});
