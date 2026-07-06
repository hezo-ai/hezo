import { describe, expect, it } from 'vitest';
import type { ContainerRunUser } from '../src/services/container-user';
import { ContainerGitExecutor, GIT_SSH_COMMAND_VALUE } from '../src/services/git-executor';
import {
	BRIDGE_RUNNER_BINARY,
	type BridgeRunnerArgs,
	buildBridgeRunnerArgv,
} from '../src/services/ssh-agent';
import { createStubDocker } from './helpers/app';

const runUser: ContainerRunUser = { name: 'node', uid: 1000, gid: 1000 };

const bridge: BridgeRunnerArgs = {
	socketPath: '/run/hezo/test.sock',
	socketUser: 'node',
	tokenHex: '0123456789abcdef0123456789abcdef',
	hostName: 'host.docker.internal',
	hostPort: 12345,
};

interface RecordedExec {
	Cmd: string[];
	Env?: string[];
	WorkingDir?: string;
	User?: string;
}

function recordingDocker(opts: { exitCode?: number; throwOnStart?: boolean } = {}) {
	const calls: RecordedExec[] = [];
	const docker = createStubDocker({
		execCreate: async (_id: string, config: RecordedExec) => {
			calls.push(config);
			return 'exec-1';
		},
		execStart: async () => {
			if (opts.throwOnStart) throw new Error('docker daemon unreachable');
			return { stdout: 'out', stderr: 'err' };
		},
		execInspect: async () => ({ ExitCode: opts.exitCode ?? 0, Running: false, Pid: 1 }),
	});
	return { docker, calls };
}

const abortErrorOf = (s: AbortSignal): Error =>
	s.reason instanceof Error
		? s.reason
		: new DOMException('This operation was aborted', 'AbortError');

// A docker whose execStart never settles until the exec's abort signal fires —
// modelling a black-holed in-container command (e.g. a stalled `git fetch`), the
// production failure this executor's timeout/run-signal handling must survive.
function hangingDocker() {
	return createStubDocker({
		execCreate: async () => 'exec-1',
		execStart: (_id: string, opts?: { signal?: AbortSignal }) =>
			new Promise<{ stdout: string; stderr: string }>((_resolve, reject) => {
				const signal = opts?.signal;
				if (!signal) return;
				if (signal.aborted) return reject(abortErrorOf(signal));
				signal.addEventListener('abort', () => reject(abortErrorOf(signal)), { once: true });
			}),
		execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 1 }),
	});
}

describe('ContainerGitExecutor', () => {
	it('runs a plain git command in the container as the run-user', async () => {
		const { docker, calls } = recordingDocker();
		const exec = new ContainerGitExecutor(docker, 'cid', {
			baseEnv: ['GIT_CONFIG_COUNT=0'],
			runUser,
		});

		const res = await exec.exec(['status', '--porcelain'], { cwd: '/worktrees/T-1/repo' });

		expect(res).toEqual({ exitCode: 0, stdout: 'out', stderr: 'err' });
		expect(calls).toHaveLength(1);
		expect(calls[0].Cmd).toEqual(['git', 'status', '--porcelain']);
		expect(calls[0].WorkingDir).toBe('/worktrees/T-1/repo');
		expect(calls[0].User).toBe('node');
	});

	it('runs as the detected run-user, not a hardcoded node (custom image)', async () => {
		const { docker, calls } = recordingDocker();
		const exec = new ContainerGitExecutor(docker, 'cid', {
			baseEnv: [],
			runUser: { name: 'appuser', uid: 1001, gid: 1001 },
		});

		await exec.exec(['status'], { cwd: '/w' });

		expect(calls[0].User).toBe('appuser');
	});

	it('wraps SSH-transport ops with the bridge runner', async () => {
		const { docker, calls } = recordingDocker();
		const exec = new ContainerGitExecutor(docker, 'cid', { baseEnv: [], bridge, runUser });

		await exec.exec(['fetch', '--all', '--prune'], { cwd: '/workspace/repo', needsSsh: true });

		expect(calls[0].Cmd[0]).toBe(BRIDGE_RUNNER_BINARY);
		expect(calls[0].Cmd).toEqual([
			...buildBridgeRunnerArgv(bridge),
			'git',
			'fetch',
			'--all',
			'--prune',
		]);
	});

	it('does not wrap when needsSsh but no bridge is available', async () => {
		const { docker, calls } = recordingDocker();
		const exec = new ContainerGitExecutor(docker, 'cid', { baseEnv: [], bridge: null, runUser });

		await exec.exec(['fetch'], { cwd: '/workspace/repo', needsSsh: true });

		expect(calls[0].Cmd).toEqual(['git', 'fetch']);
	});

	it('passes identity + SSH_AUTH_SOCK but never HEZO_PROMPT_FILE', async () => {
		const { docker, calls } = recordingDocker();
		const exec = new ContainerGitExecutor(docker, 'cid', {
			baseEnv: [
				'GIT_CONFIG_COUNT=2',
				'SSH_AUTH_SOCK=/run/hezo/run.sock',
				'HEZO_PROMPT_FILE=/tmp/prompt.txt',
			],
			runUser,
		});

		await exec.exec(['status'], { cwd: '/w' });

		expect(calls[0].Env).toContain('SSH_AUTH_SOCK=/run/hezo/run.sock');
		expect(calls[0].Env).toContain('GIT_CONFIG_COUNT=2');
		expect(calls[0].Env?.some((e) => e.startsWith('HEZO_PROMPT_FILE='))).toBe(false);
	});

	it('forPrep threads the run-user + extraEnv (git identity) alongside the prep defaults', async () => {
		const { docker, calls } = recordingDocker();
		const exec = ContainerGitExecutor.forPrep(docker, 'cid', bridge, runUser, [
			'GIT_CONFIG_COUNT=2',
			'GIT_CONFIG_KEY_0=user.name',
			'GIT_CONFIG_VALUE_0=octocat',
		]);

		// A merge (the catch-up that can create a commit) runs without needsSsh, so it
		// inherits the executor's baseEnv: prep defaults + the git identity.
		await exec.exec(['merge', '--no-edit', 'origin/main'], { cwd: '/worktrees/T-1/repo' });

		expect(calls[0].User).toBe('node');
		expect(calls[0].Env).toContain('GIT_TERMINAL_PROMPT=0');
		expect(calls[0].Env).toContain(`SSH_AUTH_SOCK=${bridge.socketPath}`);
		expect(calls[0].Env).toContain(`GIT_SSH_COMMAND=${GIT_SSH_COMMAND_VALUE}`);
		expect(calls[0].Env).toContain('GIT_CONFIG_COUNT=2');
		expect(calls[0].Env).toContain('GIT_CONFIG_KEY_0=user.name');
		expect(calls[0].Env).toContain('GIT_CONFIG_VALUE_0=octocat');
	});

	it('forPrep sets fail-fast SSH options so a stalled transport cannot hang forever', () => {
		expect(GIT_SSH_COMMAND_VALUE).toContain('BatchMode=yes');
		expect(GIT_SSH_COMMAND_VALUE).toContain('ConnectTimeout=15');
		expect(GIT_SSH_COMMAND_VALUE).toContain('ServerAliveInterval=10');
		expect(GIT_SSH_COMMAND_VALUE).toContain('ServerAliveCountMax=3');
	});

	it('surfaces a non-zero exit code from execInspect', async () => {
		const { docker } = recordingDocker({ exitCode: 128 });
		const exec = new ContainerGitExecutor(docker, 'cid', { baseEnv: [], runUser });

		const res = await exec.exec(['rev-parse', '--git-dir'], { cwd: '/w' });

		expect(res.exitCode).toBe(128);
	});

	it('returns exitCode 1 instead of throwing when docker fails', async () => {
		const { docker } = recordingDocker({ throwOnStart: true });
		const exec = new ContainerGitExecutor(docker, 'cid', { baseEnv: [], runUser });

		const res = await exec.exec(['status'], { cwd: '/w' });

		expect(res.exitCode).toBe(1);
		expect(res.stderr).toContain('docker daemon unreachable');
	});

	it('times out a hung exec at the per-op deadline instead of hanging', async () => {
		const exec = ContainerGitExecutor.forPrep(hangingDocker(), 'cid', bridge, runUser);

		const res = await exec.exec(['fetch', '--prune', 'origin'], {
			cwd: '/workspace/repo',
			needsSsh: true,
			timeout: 50,
		});

		expect(res.exitCode).toBe(1);
		expect(res.stderr).toContain('timed out');
	});

	it('interrupts an in-flight exec when the run signal aborts', async () => {
		const ac = new AbortController();
		const exec = ContainerGitExecutor.forPrep(
			hangingDocker(),
			'cid',
			bridge,
			runUser,
			[],
			ac.signal,
		);

		const p = exec.exec(['fetch', '--prune', 'origin'], {
			cwd: '/workspace/repo',
			needsSsh: true,
			timeout: 60_000,
		});
		ac.abort();
		const res = await p;

		expect(res.exitCode).toBe(1);
		expect(res.stderr).toBe('run aborted');
	});
});
