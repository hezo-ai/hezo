import { describe, expect, it } from 'vitest';
import { ensureContainerDirReady } from '../src/services/container-user';
import type { DockerClient } from '../src/services/docker';

/**
 * A docker mock that scripts a sequence of exit codes for the readiness probe
 * (`mkdir -p <p> && test -d <p>`): `exitCodes[i]` is returned for the i-th exec,
 * and once exhausted the last code repeats. Records every exec script so a test
 * can assert the probe shape and the exact attempt count. `throwOnExec` makes
 * `execCreate` throw, exercising the swallow-and-retry path.
 */
function scriptedDocker(opts: { exitCodes?: number[]; throwOnExec?: boolean }) {
	const exitCodes = opts.exitCodes ?? [0];
	const scripts: string[] = [];
	const byId = new Map<string, string>();
	let seq = 0;

	const docker = {
		execCreate: async (_id: string, config: { Cmd: string[] }) => {
			if (opts.throwOnExec) throw new Error('docker unreachable');
			const execId = `exec-${seq++}`;
			scripts.push(config.Cmd[2] ?? '');
			byId.set(execId, config.Cmd[2] ?? '');
			return execId;
		},
		execStart: async () => ({ stdout: '', stderr: '' }),
		execInspect: async (execId: string) => {
			const idx = Number(execId.split('-')[1]);
			const code = idx < exitCodes.length ? exitCodes[idx] : exitCodes[exitCodes.length - 1];
			return { ExitCode: code, Running: false, Pid: 0 };
		},
	} as unknown as DockerClient;

	return { docker, scripts };
}

describe('ensureContainerDirReady', () => {
	it('confirms on the first attempt when the dir is already visible (no wasted retries)', async () => {
		const { docker, scripts } = scriptedDocker({ exitCodes: [0] });
		const ok = await ensureContainerDirReady(docker, 'cid', '/worktrees/TO-1', {
			retries: 3,
			delayMs: 0,
		});
		expect(ok).toBe(true);
		expect(scripts).toHaveLength(1); // one exec on the happy path — zero added latency
		// The probe creates AND re-stats the path so a not-yet-visible mkdir still loops.
		expect(scripts[0]).toContain('mkdir -p');
		expect(scripts[0]).toContain('test -d');
		expect(scripts[0]).toContain("'/worktrees/TO-1'");
	});

	it('retries a transient miss and returns true as soon as the dir appears', async () => {
		// exit 1, 1, 0 — the mount settles on the third probe.
		const { docker, scripts } = scriptedDocker({ exitCodes: [1, 1, 0] });
		const ok = await ensureContainerDirReady(docker, 'cid', '/worktrees/TO-2', {
			retries: 5,
			delayMs: 0,
		});
		expect(ok).toBe(true);
		expect(scripts).toHaveLength(3); // stopped the instant it was confirmed
	});

	it('returns false (never throws) after exactly `retries` attempts when never confirmed', async () => {
		const { docker, scripts } = scriptedDocker({ exitCodes: [1] });
		const ok = await ensureContainerDirReady(docker, 'cid', '/worktrees/TO-3', {
			retries: 3,
			delayMs: 0,
		});
		expect(ok).toBe(false);
		expect(scripts).toHaveLength(3); // bounded — never loops past the cap
	});

	it('returns false (never throws) when the docker exec itself fails every time', async () => {
		const { docker } = scriptedDocker({ throwOnExec: true });
		await expect(
			ensureContainerDirReady(docker, 'cid', '/worktrees/TO-4', { retries: 3, delayMs: 0 }),
		).resolves.toBe(false);
	});
});
