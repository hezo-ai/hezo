import { describe, expect, it } from 'vitest';
import type { ContainerRunUser } from '../src/services/container-user';
import { dockerSandboxHandle } from '../src/services/sandbox/handle';
import type { ExecConfig } from '../src/services/sandbox/types';
import { createStubDocker } from './helpers/app';

const NODE_USER: ContainerRunUser = { name: 'node', uid: 1000, gid: 1000 };
const ROOT_USER: ContainerRunUser = { name: 'root', uid: 0, gid: 0 };

/** Capture the exec config the handle builds, and control what the exec returns. */
function recordingEngine(result: { exitCode?: number; stdout?: string; stderr?: string } = {}) {
	const configs: ExecConfig[] = [];
	const engine = createStubDocker({
		execCreate: async (_id: string, config: ExecConfig) => {
			configs.push(config);
			return 'exec-1';
		},
		execStart: async () => ({ stdout: result.stdout ?? '', stderr: result.stderr ?? '' }),
		execInspect: async () => ({ ExitCode: result.exitCode ?? 0, Running: false, Pid: 0 }),
	});
	return { engine, configs };
}

/**
 * Elevation is a flag rather than a username because no third-party sandbox
 * provider honours a per-exec user - Daytona's exec takes only command, cwd, env
 * and timeout, and Modal documents no equivalent. What these assert is that the
 * intent survives translation into whatever the backend can actually express.
 */
describe('dockerSandboxHandle', () => {
	it('runs unelevated as the container run user by default', async () => {
		const { engine, configs } = recordingEngine();
		await dockerSandboxHandle(engine, 'c1', NODE_USER).exec({ cmd: ['git', 'status'] });
		expect(configs[0].User).toBe('node');
	});

	it('runs elevated as root', async () => {
		const { engine, configs } = recordingEngine();
		await dockerSandboxHandle(engine, 'c1', NODE_USER).exec({
			cmd: ['chown', 'node', '/workspace'],
			elevated: true,
		});
		expect(configs[0].User).toBe('root');
	});

	it('makes elevation a no-op when the image has no non-root user', async () => {
		// A custom docker_base_image may have no `node`; resolveContainerRunUser
		// already falls back to root, so both branches agree rather than the
		// unelevated path trying to become a user that does not exist.
		const { engine, configs } = recordingEngine();
		const handle = dockerSandboxHandle(engine, 'c1', ROOT_USER);
		await handle.exec({ cmd: ['id'] });
		await handle.exec({ cmd: ['id'], elevated: true });
		expect(configs.map((c) => c.User)).toEqual(['root', 'root']);
	});

	it('passes through cmd, env and working dir, and always attaches both streams', async () => {
		const { engine, configs } = recordingEngine();
		await dockerSandboxHandle(engine, 'c1', NODE_USER).exec({
			cmd: ['sh', '-c', 'echo hi'],
			env: ['FOO=bar'],
			workingDir: '/worktrees/T-1/repo',
		});
		expect(configs[0]).toMatchObject({
			Cmd: ['sh', '-c', 'echo hi'],
			Env: ['FOO=bar'],
			WorkingDir: '/worktrees/T-1/repo',
			AttachStdout: true,
			AttachStderr: true,
		});
	});

	it('returns the exit code alongside the output', async () => {
		// The exit code arrives from a third call today (execInspect). Collapsing
		// the triad is the point: a provider exec returns it with the stream, and
		// no caller should have to know which shape it came from.
		const { engine } = recordingEngine({ exitCode: 128, stdout: 'out', stderr: 'boom' });
		const outcome = await dockerSandboxHandle(engine, 'c1', NODE_USER).exec({ cmd: ['git'] });
		expect(outcome).toEqual({ exitCode: 128, stdout: 'out', stderr: 'boom' });
	});

	it('streams through onChunk and retains nothing', async () => {
		const chunks: string[] = [];
		const engine = createStubDocker({
			execCreate: async () => 'exec-1',
			execStart: async (_id: string, opts?: { onChunk?: (c: unknown) => void }) => {
				opts?.onChunk?.({ stream: 'stdout', text: 'hello' });
				return { stdout: '', stderr: '' };
			},
			execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
		});
		const outcome = await dockerSandboxHandle(engine, 'c1', NODE_USER).exec({
			cmd: ['agent'],
			onChunk: (c) => {
				chunks.push(c.text);
			},
		});
		expect(chunks).toEqual(['hello']);
		// An agent run's transcript reaches hundreds of MB, so the streaming path
		// must not accumulate it - a handle that buffered would reintroduce
		// exactly the cost the onChunk contract exists to avoid.
		expect(outcome.stdout).toBe('');
		expect(outcome.stderr).toBe('');
	});
});
