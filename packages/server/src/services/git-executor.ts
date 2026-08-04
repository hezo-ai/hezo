import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { trackBackground } from '../lib/background';
import type { ContainerRunUser } from './container-user';
import type { ContainerEngine } from './docker';
import { hostSandboxFiles, type SandboxFiles } from './sandbox/files';
import { dockerSandboxHandle, type SandboxHandle } from './sandbox/handle';
import { type BridgeRunnerArgs, buildBridgeRunnerArgv } from './ssh-agent';

/**
 * Git's own network timeouts, so a stalled transfer fails fast instead of hanging
 * on libcurl's defaults. `connectTimeout` bounds the initial connect, and the
 * low-speed pair aborts a transfer that has effectively stopped (under 1 KB/s for
 * 30s) without tripping a slow-but-alive one. Worst case stays under the fetch
 * (60s) and clone (120s) op caps.
 *
 * **There is no ssh config any more.** Git transport is HTTPS on every backend
 * (see `buildGitRemoteUrl`), so the file this module used to write into every
 * container - pointing GitHub at `ssh.github.com:443` with a `HostKeyAlias`
 * against the image's pinned host keys - configured a transport nothing uses.
 * SSH remains only for commit *signing*, which is local and needs no network.
 */
export const GIT_HTTP_CONFIG_ARGS = ['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=30'];

/**
 * Mint a scope id for container git ops that run outside an agent run or a
 * provision bridge (whose ids are reused as scope ids). Shell-safe by
 * construction (`[0-9a-f]` hex under a fixed prefix).
 */
export function mintGitOpScopeId(): string {
	return `gitop-${randomBytes(8).toString('hex')}`;
}

/** Merge a run's abort signal with a per-op timeout signal (either may be absent). */
function combineAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
	const present = signals.filter((s): s is AbortSignal => s !== undefined);
	if (present.length === 0) return undefined;
	if (present.length === 1) return present[0];
	return AbortSignal.any(present);
}

export interface GitExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface GitExecOpts {
	/** Working directory for the git command. CONTAINER path in production; host temp path in tests. */
	cwd: string;
	/**
	 * This op talks to the remote (clone, fetch, push, ls-remote), so it needs
	 * git's network settings and - on an image that still has one - the per-run
	 * bridge.
	 *
	 * Was `needsSsh`, which stopped being true: transport is HTTPS and
	 * authenticates with a proxy-substituted token, not with the agent socket.
	 * The flag still marks the same call sites, it just names what they need.
	 */
	needsNetwork?: boolean;
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
	/**
	 * Reads and writes rooted at an in-container path, in the same container this
	 * executor runs git in.
	 *
	 * Here because "run git in this container" and "look at that container's
	 * files" are the same question, and every caller that has one needs the other:
	 * a repo loc pairs the cwd git uses with the seam rooted at it. Threading a
	 * second handle alongside the executor would let the two drift onto different
	 * containers, which is precisely the bug the seam exists to prevent.
	 */
	files(containerPath: string): SandboxFiles;
}

/**
 * Runs `git` as a host subprocess. Used by unit tests (and only tests in
 * production) — it is the lifted form of git.ts's former `spawn` helper, with the
 * same non-throwing, exit-code-mapping contract. `needsNetwork` is a no-op here:
 * a test drives `file://` remotes, which need nothing.
 */
export class HostGitExecutor implements GitExecutor {
	constructor(private readonly env: Record<string, string | undefined> = {}) {}

	/** Host and container paths are the same string here, by construction. */
	files(containerPath: string): SandboxFiles {
		return hostSandboxFiles(containerPath);
	}

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
	/** The run's bridge; wraps `needsNetwork` ops so their process tree stays scoped. */
	bridge?: BridgeRunnerArgs | null;
	/** The container user every git exec runs as (detected, not assumed `node`). */
	runUser: ContainerRunUser;
	/**
	 * Scope id stamped into every exec's env as `HEZO_HEARTBEAT_RUN_ID` so an
	 * abandoned exec's whole process tree (git, ssh, the bridge wrapper and its
	 * socat children) stays killable: the heartbeat run id during run prep, a
	 * `provision-<hex>`/`gitop-<hex>` tag elsewhere. On a per-op timeout or an
	 * aborted run signal the executor fires a best-effort marker kill — Docker
	 * can't signal an exec'd process, so tearing down the attach stream alone
	 * would strand the tree in the container.
	 */
	scopeId: string;
	/** The run's abort signal, so a cancel / run-timeout interrupts an in-flight exec. */
	signal?: AbortSignal;
}

/**
 * Runs `git` inside the project's already-running container via `docker exec`, so
 * the host needs no git. Remote ops (`needsNetwork`) additionally carry git's HTTP
 * timeouts and run under the per-run bridge runner, which is still what scopes the
 * process tree for the marker kill. They authenticate over **HTTPS**, with a
 * credential the egress proxy substitutes into the request - the agent socket is
 * for commit signing only. Local ops (worktree add, status, rev-parse,
 * update-ref) run bare. Mirrors the former host `spawn`'s non-throwing contract:
 * a docker transport failure or timeout returns `{ exitCode: 1 }` rather than
 * throwing, so git.ts's branching logic is unchanged.
 */
export class ContainerGitExecutor implements GitExecutor {
	private readonly bridge: BridgeRunnerArgs | null;
	private readonly baseEnv: string[];
	private readonly runUser: ContainerRunUser;
	private readonly scopeId: string;
	private readonly runSignal?: AbortSignal;
	/** Built once: exec() runs many git commands per run over a fixed container and user. */
	private readonly sandbox: SandboxHandle;

	constructor(
		private readonly docker: ContainerEngine,
		private readonly containerId: string,
		opts: ContainerGitExecutorOptions,
	) {
		this.bridge = opts.bridge ?? null;
		this.runUser = opts.runUser;
		this.scopeId = opts.scopeId;
		this.runSignal = opts.signal;
		this.sandbox = dockerSandboxHandle(docker, containerId, opts.runUser);
		// The bridge wrapper appends/redirects HEZO_PROMPT_FILE into the command it
		// runs; it must never leak into a git invocation. Strip it defensively.
		this.baseEnv = [
			...opts.baseEnv.filter((e) => !e.startsWith('HEZO_PROMPT_FILE=')),
			`HEZO_HEARTBEAT_RUN_ID=${opts.scopeId}`,
		];
	}

	/** The same container git runs in - see the note on `GitExecutor.files`. */
	files(containerPath: string): SandboxFiles {
		return this.docker.files(this.containerId, containerPath);
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
		docker: ContainerEngine,
		containerId: string,
		bridge: BridgeRunnerArgs | null,
		runUser: ContainerRunUser,
		scopeId: string,
		extraEnv: string[] = [],
		signal?: AbortSignal,
	): ContainerGitExecutor {
		const baseEnv = ['GIT_TERMINAL_PROMPT=0', ...extraEnv];
		if (bridge) baseEnv.push(`SSH_AUTH_SOCK=${bridge.socketPath}`);
		return new ContainerGitExecutor(docker, containerId, {
			baseEnv,
			bridge,
			runUser,
			scopeId,
			signal,
		});
	}

	async exec(args: string[], opts: GitExecOpts): Promise<GitExecResult> {
		const wrapped = Boolean(opts.needsNetwork && this.bridge);
		// Only a remote op gets the HTTP timeouts; a local one has no transport to
		// bound and the extra `-c` pairs would be noise on every rev-parse.
		const gitArgs = opts.needsNetwork ? [...GIT_HTTP_CONFIG_ARGS, ...args] : args;
		const cmd = wrapped
			? [...buildBridgeRunnerArgv(this.bridge as BridgeRunnerArgs), 'git', ...gitArgs]
			: ['git', ...gitArgs];
		const env = [...this.baseEnv];
		// Self-deadline for bridge-wrapped ops: newer container images run the
		// wrapped command under `timeout` so the tree dies on its own even if this
		// server process is gone before the op finishes (crash, hard kill). Old
		// images simply ignore the env. Slack over the host-side per-op timeout so
		// the host abort (and its marker kill) always fires first.
		if (wrapped && opts.timeout) {
			env.push(`HEZO_EXEC_DEADLINE_SECS=${Math.ceil(opts.timeout / 1000) + 15}`);
		}
		// The per-op deadline and the run's own abort (cancel / run-timeout) both
		// interrupt an in-flight exec; whichever fires tears down the docker stream.
		const timeoutSignal = opts.timeout ? AbortSignal.timeout(opts.timeout) : undefined;
		const signal = combineAbortSignals(this.runSignal, timeoutSignal);
		try {
			// Git runs unelevated so anything it writes into the bind-mounted
			// workspace stays owned by the run user rather than root.
			return await this.sandbox.exec({
				cmd,
				env,
				workingDir: opts.cwd,
				signal,
			});
		} catch (e) {
			if (timeoutSignal?.aborted) {
				this.killAbandonedExec();
				return {
					exitCode: 1,
					stdout: '',
					stderr: `timed out after ${Math.round((opts.timeout ?? 0) / 1000)}s`,
				};
			}
			if (this.runSignal?.aborted) {
				this.killAbandonedExec();
				return { exitCode: 1, stdout: '', stderr: 'run aborted' };
			}
			return { exitCode: 1, stdout: '', stderr: e instanceof Error ? e.message : String(e) };
		}
	}

	/**
	 * Aborting an exec only tears down its attach stream — Docker leaves the
	 * process running in the container, so a timed-out/aborted git op would
	 * strand its git/ssh/bridge tree there indefinitely. Reap it by the scope
	 * marker every exec of this executor carries. Fire-and-forget and
	 * best-effort: a generic transport error skips this (the container is likely
	 * gone), and the startup sweep is the backstop either way.
	 */
	private killAbandonedExec(): void {
		trackBackground(this.docker.killRunProcesses(this.containerId, this.scopeId).catch(() => {}));
	}
}
