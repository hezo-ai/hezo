import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { trackBackground } from '../lib/background';
import type { ContainerRunUser } from './container-user';
import type { ContainerEngine } from './docker';
import { hostSandboxFiles, type SandboxFiles } from './sandbox/files';
import { dockerSandboxHandle, type SandboxHandle } from './sandbox/handle';
import { type BridgeRunnerArgs, buildBridgeRunnerArgv } from './ssh-agent';

/** Where the ssh config Hezo writes into every container lives. */
export const CONTAINER_SSH_CONFIG_PATH = '/etc/hezo/ssh_config';

/**
 * The ssh config every in-container git op is pointed at.
 *
 * **GitHub over port 443, not 22.** A container's egress is not the operator's:
 * a managed sandbox provider commonly allows only 80 and 443 out, and a dropped
 * SYN on 22 surfaces as `ssh: connect to host github.com port 22: Connection
 * timed out` after `ConnectTimeout` - so every clone, fetch and push failed on
 * that backend while working perfectly on a local daemon, where the daemon NATs
 * the container onto a network that has 22 open. `ssh.github.com:443` is
 * GitHub's own endpoint for exactly this, serving the same SSH service.
 *
 * Applied on **every** backend rather than only where 22 is blocked. A
 * per-backend branch would mean the path local dev and CI exercise is not the
 * one production runs, which is the failure this whole seam exists to prevent -
 * and there is nothing to gain from 22 where both work.
 *
 * `HostKeyAlias` is load-bearing and easy to miss: the image pins GitHub's host
 * keys under the name `github.com` (`docker/Dockerfile.agent-base`), and without
 * the alias ssh would look them up under `ssh.github.com` and refuse the
 * connection it just successfully made. The alias keeps the pin exact while the
 * address changes.
 */
export const CONTAINER_SSH_CONFIG = `# Written by Hezo at container provision. Do not edit.
Host github.com
    HostName ssh.github.com
    Port 443
    User git
    HostKeyAlias github.com
`;

/**
 * SSH options applied to every in-container git transport op so a stalled
 * connection fails fast instead of hanging on OS TCP defaults. `ConnectTimeout`
 * bounds the initial connect; `ServerAliveInterval`/`ServerAliveCountMax` detect
 * an established-then-silent connection (~30s) without tripping a slow-but-alive
 * transfer; `BatchMode` guarantees git never blocks on an interactive prompt.
 * Worst case (~45s) stays under the fetch (60s) and clone (120s) op caps.
 *
 * `-F` names {@link CONTAINER_SSH_CONFIG_PATH} explicitly rather than relying on
 * the distro dropping our file into an `Include`: the base image is Debian
 * today, the include layout is a distro convention rather than an ssh one, and a
 * config silently not read presents as the same connect timeout it was written
 * to fix. The system config still applies underneath; ours is consulted first,
 * and ssh takes the first value it obtains for a keyword.
 */
export const GIT_SSH_COMMAND_VALUE =
	`ssh -F ${CONTAINER_SSH_CONFIG_PATH} -o BatchMode=yes -o ConnectTimeout=15 ` +
	'-o ServerAliveInterval=10 -o ServerAliveCountMax=3';

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
 * same non-throwing, exit-code-mapping contract. `needsSsh` is a no-op here: any
 * SSH config a test needs is supplied through the injected `env`.
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
	/** The run's SSH bridge; required for `needsSsh` ops. Null disables SSH wrapping. */
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
		const baseEnv = [
			'GIT_TERMINAL_PROMPT=0',
			`GIT_SSH_COMMAND=${GIT_SSH_COMMAND_VALUE}`,
			...extraEnv,
		];
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
		const wrapped = Boolean(opts.needsSsh && this.bridge);
		const cmd =
			opts.needsSsh && this.bridge
				? [...buildBridgeRunnerArgv(this.bridge), 'git', ...args]
				: ['git', ...args];
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
