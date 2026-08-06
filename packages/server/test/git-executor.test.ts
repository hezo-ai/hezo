import { describe, expect, it, vi } from 'vitest';
import type { ContainerRunUser } from '../src/services/container-user';
import { buildEgressProxyEnv } from '../src/services/egress';
import { ContainerGitExecutor, GIT_HTTP_TIMEOUT_ENV } from '../src/services/git-executor';
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
	const kills: Array<{ containerId: string; runId: string }> = [];
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
		killRunProcesses: async (containerId: string, runId: string) => {
			kills.push({ containerId, runId });
		},
	});
	return { docker, calls, kills };
}

const abortErrorOf = (s: AbortSignal): Error =>
	s.reason instanceof Error
		? s.reason
		: new DOMException('This operation was aborted', 'AbortError');

// A docker whose execStart never settles until the exec's abort signal fires —
// modelling a black-holed in-container command (e.g. a stalled `git fetch`), the
// production failure this executor's timeout/run-signal handling must survive.
function hangingDocker() {
	const kills: Array<{ containerId: string; runId: string }> = [];
	const docker = createStubDocker({
		execCreate: async () => 'exec-1',
		execStart: (_id: string, opts?: { signal?: AbortSignal }) =>
			new Promise<{ stdout: string; stderr: string }>((_resolve, reject) => {
				const signal = opts?.signal;
				if (!signal) return;
				if (signal.aborted) return reject(abortErrorOf(signal));
				signal.addEventListener('abort', () => reject(abortErrorOf(signal)), { once: true });
			}),
		execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 1 }),
		killRunProcesses: async (containerId: string, runId: string) => {
			kills.push({ containerId, runId });
		},
	});
	return { docker, kills };
}

describe('ContainerGitExecutor', () => {
	it('runs a plain git command in the container as the run-user', async () => {
		const { docker, calls } = recordingDocker();
		const exec = new ContainerGitExecutor(docker, 'cid', {
			baseEnv: ['GIT_CONFIG_COUNT=0'],
			runUser,
			scopeId: 'gitop-0000000000000000',
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
			scopeId: 'gitop-0000000000000000',
		});

		await exec.exec(['status'], { cwd: '/w' });

		expect(calls[0].User).toBe('appuser');
	});

	it('wraps SSH-transport ops with the bridge runner', async () => {
		const { docker, calls } = recordingDocker();
		const exec = new ContainerGitExecutor(docker, 'cid', {
			baseEnv: [],
			bridge,
			runUser,
			scopeId: 'gitop-0000000000000000',
		});

		await exec.exec(['fetch', '--all', '--prune'], { cwd: '/workspace/repo', needsNetwork: true });

		expect(calls[0].Cmd[0]).toBe(BRIDGE_RUNNER_BINARY);
		expect(calls[0].Cmd).toEqual([
			...buildBridgeRunnerArgv(bridge),
			'git',
			'fetch',
			'--all',
			'--prune',
		]);
	});

	it('does not wrap when needsNetwork but no bridge is available', async () => {
		const { docker, calls } = recordingDocker();
		const exec = new ContainerGitExecutor(docker, 'cid', {
			baseEnv: [],
			bridge: null,
			runUser,
			scopeId: 'gitop-0000000000000000',
		});

		await exec.exec(['fetch'], { cwd: '/workspace/repo', needsNetwork: true });

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
			scopeId: 'gitop-0000000000000000',
		});

		await exec.exec(['status'], { cwd: '/w' });

		expect(calls[0].Env).toContain('SSH_AUTH_SOCK=/run/hezo/run.sock');
		expect(calls[0].Env).toContain('GIT_CONFIG_COUNT=2');
		expect(calls[0].Env?.some((e) => e.startsWith('HEZO_PROMPT_FILE='))).toBe(false);
	});

	it('forPrep threads the run-user + extraEnv (git identity) alongside the prep defaults', async () => {
		const { docker, calls } = recordingDocker();
		const exec = ContainerGitExecutor.forPrep(docker, 'cid', bridge, runUser, 'run-scope-1', [
			'GIT_CONFIG_COUNT=2',
			'GIT_CONFIG_KEY_0=user.name',
			'GIT_CONFIG_VALUE_0=octocat',
		]);

		// A merge (the catch-up that can create a commit) runs without needsNetwork,
		// so it inherits the executor's baseEnv: prep defaults + the git identity.
		await exec.exec(['merge', '--no-edit', 'origin/main'], { cwd: '/worktrees/T-1/repo' });

		expect(calls[0].User).toBe('node');
		expect(calls[0].Env).toContain('GIT_TERMINAL_PROMPT=0');
		expect(calls[0].Env).toContain(`SSH_AUTH_SOCK=${bridge.socketPath}`);
		expect(calls[0].Env).toContain('GIT_CONFIG_COUNT=2');
		expect(calls[0].Env).toContain('GIT_CONFIG_KEY_0=user.name');
		expect(calls[0].Env).toContain('GIT_CONFIG_VALUE_0=octocat');
	});

	/**
	 * The proxy entries are how a clone's `__HEZO_SECRET_<NAME>__` ever becomes a
	 * credential: substitution happens at the egress proxy, and git only reaches
	 * it if these are in the exec env. Nothing in this executor supplies them —
	 * the caller passes them through `extraEnv` — so the regression is a caller
	 * that forgets, and the symptom is GitHub reporting a perfectly good token as
	 * invalid because it was shown a placeholder instead.
	 */
	it('carries caller-supplied proxy env onto remote ops', async () => {
		const { docker, calls } = recordingDocker();
		const proxyEnv = buildEgressProxyEnv({ host: '127.0.0.1', port: 34567, token: 'tok' });
		const exec = ContainerGitExecutor.forPrep(
			docker,
			'cid',
			null,
			runUser,
			'scope-proxy',
			proxyEnv,
		);

		await exec.exec(['clone', 'https://github.com/o/r.git'], {
			cwd: '/workspace',
			needsNetwork: true,
		});
		expect(calls[0]?.Env).toContain('HTTPS_PROXY=http://run:tok@127.0.0.1:34567');
		expect(calls[0]?.Env).toContain('https_proxy=http://run:tok@127.0.0.1:34567');
		expect(calls[0]?.Env).toContain('HTTP_PROXY=http://run:tok@127.0.0.1:34567');
	});

	it('carries git HTTP timeouts on a remote op, and nothing extra on a local one', async () => {
		// A stalled transfer has to fail fast rather than hang on libcurl's defaults.
		// Env, not `-c` argv: a prefix on the command line silently stops the
		// scripted-docker suites from matching their own `fetch` rules.
		const { docker, calls } = recordingDocker();
		const exec = ContainerGitExecutor.forPrep(docker, 'cid', null, runUser, 'scope-http');

		await exec.exec(['fetch', 'origin'], { cwd: '/workspace/repo', needsNetwork: true });
		expect(calls[0]?.Cmd).toEqual(['git', 'fetch', 'origin']);
		for (const entry of GIT_HTTP_TIMEOUT_ENV) expect(calls[0]?.Env).toContain(entry);

		await exec.exec(['rev-parse', 'HEAD'], { cwd: '/workspace/repo' });
		expect(calls[1]?.Cmd).toEqual(['git', 'rev-parse', 'HEAD']);
		for (const entry of GIT_HTTP_TIMEOUT_ENV) expect(calls[1]?.Env).not.toContain(entry);
	});

	it('no longer sets GIT_SSH_COMMAND - transport is HTTPS, ssh is for signing', async () => {
		const { docker, calls } = recordingDocker();
		const exec = ContainerGitExecutor.forPrep(docker, 'cid', null, runUser, 'scope-nossh');
		await exec.exec(['status'], { cwd: '/workspace/repo' });
		const env: string[] = calls[0]?.Env ?? [];
		expect(env.some((e) => e.startsWith('GIT_SSH_COMMAND='))).toBe(false);
	});

	it('surfaces a non-zero exit code from execInspect', async () => {
		const { docker } = recordingDocker({ exitCode: 128 });
		const exec = new ContainerGitExecutor(docker, 'cid', {
			baseEnv: [],
			runUser,
			scopeId: 'gitop-0000000000000000',
		});

		const res = await exec.exec(['rev-parse', '--git-dir'], { cwd: '/w' });

		expect(res.exitCode).toBe(128);
	});

	it('returns exitCode 1 instead of throwing when docker fails', async () => {
		const { docker } = recordingDocker({ throwOnStart: true });
		const exec = new ContainerGitExecutor(docker, 'cid', {
			baseEnv: [],
			runUser,
			scopeId: 'gitop-0000000000000000',
		});

		const res = await exec.exec(['status'], { cwd: '/w' });

		expect(res.exitCode).toBe(1);
		expect(res.stderr).toContain('docker daemon unreachable');
	});

	it('stamps every exec env with the HEZO_HEARTBEAT_RUN_ID scope marker', async () => {
		const { docker, calls } = recordingDocker();
		const exec = ContainerGitExecutor.forPrep(docker, 'cid', bridge, runUser, 'run-scope-1');

		await exec.exec(['status'], { cwd: '/w' });
		await exec.exec(['fetch', '--prune', 'origin'], {
			cwd: '/w',
			needsNetwork: true,
			timeout: 60_000,
		});

		// Both plain and bridge-wrapped ops carry the marker, so an abandoned tree
		// (git, ssh, socat, the bridge wrapper) is killable by env scan.
		expect(calls[0].Env).toContain('HEZO_HEARTBEAT_RUN_ID=run-scope-1');
		expect(calls[1].Env).toContain('HEZO_HEARTBEAT_RUN_ID=run-scope-1');
	});

	it('sets a self-deadline env only for bridge-wrapped ops with a timeout', async () => {
		const { docker, calls } = recordingDocker();
		const exec = ContainerGitExecutor.forPrep(docker, 'cid', bridge, runUser, 'run-scope-1');

		await exec.exec(['fetch', '--prune', 'origin'], {
			cwd: '/w',
			needsNetwork: true,
			timeout: 60_000,
		});
		await exec.exec(['status'], { cwd: '/w', timeout: 30_000 });

		// 60s op cap + 15s slack, so the host-side abort always fires first and the
		// in-container `timeout` only matters when the server itself is gone.
		expect(calls[0].Env).toContain('HEZO_EXEC_DEADLINE_SECS=75');
		expect(calls[1].Env?.some((e) => e.startsWith('HEZO_EXEC_DEADLINE_SECS='))).toBe(false);
	});

	it('times out a hung exec at the per-op deadline and reaps the abandoned tree', async () => {
		const { docker, kills } = hangingDocker();
		const exec = ContainerGitExecutor.forPrep(docker, 'cid', bridge, runUser, 'run-scope-1');

		const res = await exec.exec(['fetch', '--prune', 'origin'], {
			cwd: '/workspace/repo',
			needsNetwork: true,
			timeout: 50,
		});

		expect(res.exitCode).toBe(1);
		expect(res.stderr).toContain('timed out');
		// The abandoned in-container tree is killed by its scope marker — aborting
		// the exec stream alone would leave git/ssh/socat running in the container.
		await vi.waitFor(() => {
			expect(kills).toEqual([{ containerId: 'cid', runId: 'run-scope-1' }]);
		});
	});

	it('interrupts an in-flight exec when the run signal aborts and reaps the tree', async () => {
		const ac = new AbortController();
		const { docker, kills } = hangingDocker();
		const exec = ContainerGitExecutor.forPrep(
			docker,
			'cid',
			bridge,
			runUser,
			'run-scope-1',
			[],
			ac.signal,
		);

		const p = exec.exec(['fetch', '--prune', 'origin'], {
			cwd: '/workspace/repo',
			needsNetwork: true,
			timeout: 60_000,
		});
		ac.abort();
		const res = await p;

		expect(res.exitCode).toBe(1);
		expect(res.stderr).toBe('run aborted');
		await vi.waitFor(() => {
			expect(kills).toEqual([{ containerId: 'cid', runId: 'run-scope-1' }]);
		});
	});

	it('does not fire the marker kill on success or on a docker transport error', async () => {
		const ok = recordingDocker();
		const okExec = ContainerGitExecutor.forPrep(ok.docker, 'cid', bridge, runUser, 'run-scope-1');
		await okExec.exec(['fetch', '--prune', 'origin'], {
			cwd: '/w',
			needsNetwork: true,
			timeout: 50,
		});

		// Transport error (daemon unreachable): the container is likely gone, so no
		// kill is attempted — the startup sweep is the backstop.
		const broken = recordingDocker({ throwOnStart: true });
		const brokenExec = ContainerGitExecutor.forPrep(
			broken.docker,
			'cid',
			bridge,
			runUser,
			'run-scope-1',
		);
		await brokenExec.exec(['fetch', '--prune', 'origin'], { cwd: '/w', needsNetwork: true });

		expect(ok.kills).toEqual([]);
		expect(broken.kills).toEqual([]);
	});
});
