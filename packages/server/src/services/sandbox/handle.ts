import type { ContainerRunUser } from '../container-user';
import type { ContainerEngine, ExecLogChunk } from './types';

/**
 * What to run inside a container, without saying which OS user runs it.
 *
 * Privilege is expressed as a flag rather than a username because **no
 * third-party sandbox provider honours a per-exec user**. Docker takes a `User`
 * on every exec; Daytona's `exec()` accepts only command, cwd, env and timeout
 * (per-command user switching is an open request, daytonaio/daytona#4309), and
 * Modal documents no equivalent. Both set a user when the sandbox is created
 * instead.
 *
 * A username is therefore the wrong thing for a call site to state: it is an
 * instruction only one backend can follow. `elevated` is the actual intent, and
 * each backend renders it however it can - Docker as `User: root`, a provider
 * as a `sudo -n` prefix (the agent image already grants the run user
 * passwordless sudo).
 */
export interface ExecSpec {
	cmd: string[];
	env?: string[];
	workingDir?: string;
	/**
	 * Run with elevation. False (the default) runs as the container's detected
	 * run user - `node` on the stock image.
	 *
	 * Elevation is needed for the ownership fixes, the CA trust refresh, the MTU
	 * pin and the `/proc` scans; agent work, git and chat turns run unelevated so
	 * bind-mounted files stay non-root-owned. It is **not** a security boundary:
	 * the run user has passwordless sudo by design.
	 */
	elevated?: boolean;
	signal?: AbortSignal;
	/**
	 * Per-frame callback. Supplying it streams and retains nothing, so `stdout`
	 * and `stderr` on the result come back empty - see `ExecStartOpts.onChunk`.
	 */
	onChunk?: (chunk: ExecLogChunk) => void | Promise<void>;
}

export interface ExecOutcome {
	exitCode: number;
	/** Empty when `onChunk` was supplied. */
	stdout: string;
	/** Empty when `onChunk` was supplied. */
	stderr: string;
}

/**
 * A container a run has been given, addressed without naming a runtime.
 *
 * Today this wraps one long-lived per-project Docker container. It is the shape
 * a pool member will have, which is why `exec` collapses the
 * `execCreate`/`execStart`/`execInspect` triad the call sites currently repeat:
 * that triad is Docker's wire protocol, not something a caller should have to
 * know, and a provider exec returns its exit code with the stream.
 */
export interface SandboxHandle {
	readonly containerId: string;
	exec(spec: ExecSpec): Promise<ExecOutcome>;
}

/**
 * {@link SandboxHandle} over a Docker container.
 *
 * `runUser` is resolved once per container by `resolveContainerRunUser` and
 * closed over here, which is the reason elevation belongs at this layer rather
 * than on `ContainerEngine`: the engine has no way to learn the run user
 * without depending on `container-user.ts`, which depends on the engine.
 */
export function dockerSandboxHandle(
	engine: ContainerEngine,
	containerId: string,
	runUser: ContainerRunUser,
): SandboxHandle {
	return {
		containerId,
		async exec(spec: ExecSpec): Promise<ExecOutcome> {
			const execId = await engine.execCreate(containerId, {
				Cmd: spec.cmd,
				Env: spec.env,
				WorkingDir: spec.workingDir,
				// A custom docker_base_image may have no non-root user, in which case
				// resolveContainerRunUser already returned root and both branches
				// agree - so elevation is a no-op there rather than a special case.
				User: spec.elevated ? 'root' : runUser.name,
				AttachStdout: true,
				AttachStderr: true,
			});
			const { stdout, stderr } = await engine.execStart(execId, {
				signal: spec.signal,
				onChunk: spec.onChunk,
			});
			const { ExitCode } = await engine.execInspect(execId);
			return { exitCode: ExitCode, stdout, stderr };
		},
	};
}
