import { execFile } from 'node:child_process';
import type { ContainerRunUser } from './container-user';
import type { DockerClient } from './docker';
import { type BridgeRunnerArgs, buildBridgeRunnerArgv } from './ssh-agent';

export interface GitExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface GitExecOpts {
	/** Working directory for the git command. CONTAINER path in production; host temp path in tests. */
	cwd: string;
	/** Wrap the command with the per-run SSH bridge so transport (clone/fetch/push) can auth. */
	needsSsh?: boolean;
	/** Milliseconds before the command is abandoned. */
	timeout?: number;
}

/**
 * The seam through which every git command runs. Production drives git inside the
 * project container (`ContainerGitExecutor`); tests drive the same orchestration
 * against a host `git` (`HostGitExecutor`) so no Docker is needed. The host process
 * itself never runs git in production — Hezo's only prerequisite is Docker.
 */
export interface GitExecutor {
	exec(args: string[], opts: GitExecOpts): Promise<GitExecResult>;
}

/**
 * Runs `git` as a host subprocess. Used by unit tests (and only tests in
 * production) — it is the lifted form of git.ts's former `spawn` helper, with the
 * same non-throwing, exit-code-mapping contract. `needsSsh` is a no-op here: any
 * SSH config a test needs is supplied through the injected `env`.
 */
export class HostGitExecutor implements GitExecutor {
	constructor(private readonly env: Record<string, string | undefined> = {}) {}

	exec(args: string[], opts: GitExecOpts): Promise<GitExecResult> {
		return new Promise((resolve) => {
			execFile(
				'git',
				args,
				{ cwd: opts.cwd, env: { ...process.env, ...this.env }, timeout: opts.timeout },
				(error, stdout, stderr) => {
					const timedOut = error && 'killed' in error && error.killed;
					resolve({
						exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
						stdout: stdout?.toString() ?? '',
						stderr: timedOut
							? `timed out after ${Math.round((opts.timeout ?? 0) / 1000)}s`
							: (stderr?.toString() ?? ''),
					});
				},
			);
		});
	}
}

export interface ContainerGitExecutorOptions {
	/** `KEY=value` env entries for every git exec: git identity, `SSH_AUTH_SOCK`, proxy. */
	baseEnv: string[];
	/** The run's SSH bridge; required for `needsSsh` ops. Null disables SSH wrapping. */
	bridge?: BridgeRunnerArgs | null;
	/** The container user every git exec runs as (detected, not assumed `node`). */
	runUser: ContainerRunUser;
}

/**
 * Runs `git` inside the project's already-running container via `docker exec`, so
 * the host needs no git. SSH-transport ops (`needsSsh`) are wrapped with the per-run
 * bridge runner (`hezo-run-with-bridge`) so `git@github.com:` clone/fetch/push can
 * authenticate through the host ssh-agent; the container's baked-in
 * `/etc/ssh/ssh_known_hosts` verifies the host key. Non-SSH ops (worktree add,
 * status, rev-parse, update-ref) run bare. Mirrors the former host `spawn`'s
 * non-throwing contract: a docker transport failure or timeout returns
 * `{ exitCode: 1 }` rather than throwing, so git.ts's branching logic is unchanged.
 */
export class ContainerGitExecutor implements GitExecutor {
	private readonly bridge: BridgeRunnerArgs | null;
	private readonly baseEnv: string[];
	private readonly runUser: ContainerRunUser;

	constructor(
		private readonly docker: DockerClient,
		private readonly containerId: string,
		opts: ContainerGitExecutorOptions,
	) {
		this.bridge = opts.bridge ?? null;
		this.runUser = opts.runUser;
		// The bridge wrapper appends/redirects HEZO_PROMPT_FILE into the command it
		// runs; it must never leak into a git invocation. Strip it defensively.
		this.baseEnv = opts.baseEnv.filter((e) => !e.startsWith('HEZO_PROMPT_FILE='));
	}

	/**
	 * Build a container executor for repo/worktree prep. The bridge's in-container
	 * socket is exported as `SSH_AUTH_SOCK` so wrapped clone/fetch can authenticate;
	 * `GIT_TERMINAL_PROMPT=0` stops git from ever blocking on a credential prompt.
	 * Most prep ops create no commits, but the worktree catch-up
	 * (`mergeDefaultIntoWorktree`) can record a merge commit — so worktree-building
	 * callers pass the team's git identity (+ signing) via `extraEnv` (the
	 * `GIT_CONFIG_*` entries from `buildGitIdentityEnv`); other callers omit it.
	 */
	static forPrep(
		docker: DockerClient,
		containerId: string,
		bridge: BridgeRunnerArgs | null,
		runUser: ContainerRunUser,
		extraEnv: string[] = [],
	): ContainerGitExecutor {
		const baseEnv = ['GIT_TERMINAL_PROMPT=0', ...extraEnv];
		if (bridge) baseEnv.push(`SSH_AUTH_SOCK=${bridge.socketPath}`);
		return new ContainerGitExecutor(docker, containerId, { baseEnv, bridge, runUser });
	}

	async exec(args: string[], opts: GitExecOpts): Promise<GitExecResult> {
		const cmd =
			opts.needsSsh && this.bridge
				? [...buildBridgeRunnerArgv(this.bridge), 'git', ...args]
				: ['git', ...args];
		const signal = opts.timeout ? AbortSignal.timeout(opts.timeout) : undefined;
		try {
			const execId = await this.docker.execCreate(this.containerId, {
				Cmd: cmd,
				Env: this.baseEnv,
				WorkingDir: opts.cwd,
				User: this.runUser.name,
				AttachStdout: true,
				AttachStderr: true,
			});
			const { stdout, stderr } = await this.docker.execStart(execId, { signal });
			const info = await this.docker.execInspect(execId);
			return { exitCode: info.ExitCode, stdout, stderr };
		} catch (e) {
			if (signal?.aborted) {
				return {
					exitCode: 1,
					stdout: '',
					stderr: `timed out after ${Math.round((opts.timeout ?? 0) / 1000)}s`,
				};
			}
			return { exitCode: 1, stdout: '', stderr: e instanceof Error ? e.message : String(e) };
		}
	}
}
