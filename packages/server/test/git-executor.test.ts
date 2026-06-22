import { describe, expect, it } from 'vitest';
import { ContainerGitExecutor } from '../src/services/git-executor';
import {
	BRIDGE_RUNNER_BINARY,
	type BridgeRunnerArgs,
	buildBridgeRunnerArgv,
} from '../src/services/ssh-agent';
import { createStubDocker } from './helpers/app';

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

describe('ContainerGitExecutor', () => {
	it('runs a plain git command in the container as the node user', async () => {
		const { docker, calls } = recordingDocker();
		const exec = new ContainerGitExecutor(docker, 'cid', { baseEnv: ['GIT_CONFIG_COUNT=0'] });

		const res = await exec.exec(['status', '--porcelain'], { cwd: '/worktrees/T-1/repo' });

		expect(res).toEqual({ exitCode: 0, stdout: 'out', stderr: 'err' });
		expect(calls).toHaveLength(1);
		expect(calls[0].Cmd).toEqual(['git', 'status', '--porcelain']);
		expect(calls[0].WorkingDir).toBe('/worktrees/T-1/repo');
		expect(calls[0].User).toBe('node');
	});

	it('wraps SSH-transport ops with the bridge runner', async () => {
		const { docker, calls } = recordingDocker();
		const exec = new ContainerGitExecutor(docker, 'cid', { baseEnv: [], bridge });

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
		const exec = new ContainerGitExecutor(docker, 'cid', { baseEnv: [], bridge: null });

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
		});

		await exec.exec(['status'], { cwd: '/w' });

		expect(calls[0].Env).toContain('SSH_AUTH_SOCK=/run/hezo/run.sock');
		expect(calls[0].Env).toContain('GIT_CONFIG_COUNT=2');
		expect(calls[0].Env?.some((e) => e.startsWith('HEZO_PROMPT_FILE='))).toBe(false);
	});

	it('surfaces a non-zero exit code from execInspect', async () => {
		const { docker } = recordingDocker({ exitCode: 128 });
		const exec = new ContainerGitExecutor(docker, 'cid', { baseEnv: [] });

		const res = await exec.exec(['rev-parse', '--git-dir'], { cwd: '/w' });

		expect(res.exitCode).toBe(128);
	});

	it('returns exitCode 1 instead of throwing when docker fails', async () => {
		const { docker } = recordingDocker({ throwOnStart: true });
		const exec = new ContainerGitExecutor(docker, 'cid', { baseEnv: [] });

		const res = await exec.exec(['status'], { cwd: '/w' });

		expect(res.exitCode).toBe(1);
		expect(res.stderr).toContain('docker daemon unreachable');
	});
});
