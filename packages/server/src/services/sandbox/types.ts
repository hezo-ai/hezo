import type { ContainerHostMemory } from '@hezo/shared';
import type { SandboxFiles } from './files';

export type { SandboxFiles };
/**
 * The container-engine seam.
 *
 * `ContainerEngine` is the exact set of operations Hezo needs from whatever runs
 * its agent containers. `DockerClient` (`services/docker.ts`) is the only
 * implementation today; a third-party sandbox provider is the reason the
 * interface exists. Nothing outside `services/docker.ts` should depend on the
 * concrete class.
 *
 * Layering, so the two names do not blur:
 * - **`ContainerEngine`** (this file) — "talk to a container runtime". One
 *   method per operation, mirroring the Docker Engine API because that is what
 *   the call sites were written against.
 * - **`SandboxBackend`** (later) — "give me a container to run this in". Pool
 *   membership, acquire/release, suspend. It is built *on* an engine.
 *
 * The shapes here are deliberately still Docker-flavoured. Normalizing them
 * (`elevated` instead of `User`, a neutral create spec) is a separate step, kept
 * apart from this extraction so the extraction itself provably changes nothing.
 */

/** Container create options. Mirrors the Docker Engine API create body. */
export interface ContainerConfig {
	Image: string;
	Cmd?: string[];
	Env?: string[];
	WorkingDir?: string;
	Labels?: Record<string, string>;
	HostConfig: {
		Binds?: string[];
		PortBindings?: Record<string, Array<{ HostPort: string }>>;
		ExtraHosts?: string[];
		CapAdd?: string[];
		CapDrop?: string[];
		/** Run docker-init as PID 1 so zombies are reaped under `sleep infinity`. */
		Init?: boolean;
		/**
		 * The project's working-set ceiling, in bytes - the memory this container is
		 * **guaranteed**, and the figure the instance budget is spent in units of.
		 *
		 * Stated as the ceiling itself, not as a cap plus slack. The Docker adapter
		 * sets the cgroup limit a little above it (`MEMORY_HARD_CAP_HEADROOM_BYTES`)
		 * so a runaway allocation between stats-poll ticks meets the kernel OOM
		 * killer rather than destabilizing the operator's host; a managed sandbox has
		 * no shared host to destabilize and is simply allocated this much.
		 *
		 * That split matters at the boundary, which is where it was found: with the
		 * headroom folded in here, a project set to a provider's documented maximum
		 * asked for maximum-plus-slack, was refused for exceeding the ceiling, and
		 * was told to lower a limit it had set to the advertised value - quoting a
		 * number the operator never entered. The guarantee is what the caller states;
		 * the margin above it is the adapter's business.
		 */
		Memory?: number;
		/** Equal to Memory so the cap has no swap escape valve. */
		MemorySwap?: number;
		PidsLimit?: number;
		/**
		 * Disk to allocate to this container's own filesystem, in GB.
		 *
		 * Stated by the caller on every backend; what it *means* is the adapter's
		 * to absorb, and the two differ in kind rather than in degree. A managed
		 * sandbox is given a filesystem of exactly this size, and it is the number
		 * the provider bills and quotas. A local Docker container's workspace is a
		 * bind mount with the operator's whole disk behind it, so there is nothing
		 * to allocate and the Docker adapter ignores it - a per-container quota
		 * there needs an XFS project-quota storage driver Hezo does not require.
		 *
		 * Deliberately not a "supported?" flag the caller branches on: nothing above
		 * this seam is allowed to learn which backend is in use.
		 */
		DiskGb?: number;
	};
	ExposedPorts?: Record<string, object>;
}

/** Exec create options. */
export interface ExecConfig {
	Cmd: string[];
	Env?: string[];
	WorkingDir?: string;
	/**
	 * OS user to run as. Docker honours this per exec; third-party providers
	 * generally do not (they set a user at sandbox creation instead), which is
	 * why this becomes an `elevated` flag rendered as `sudo -n` in a later step.
	 */
	User?: string;
	AttachStdout: boolean;
	AttachStderr: boolean;
	/** Only set by `openExecChannel` - the exec triad is one-way by construction. */
	AttachStdin?: boolean;
}

export interface ContainerInfo {
	Id: string;
	State: {
		Status: string;
		Running: boolean;
		Pid: number;
		ExitCode: number;
	};
	Config: {
		Image: string;
	};
}

export interface ExecLogChunk {
	stream: 'stdout' | 'stderr';
	text: string;
}

/**
 * The captured output of an exec.
 *
 * **Populated only on the buffered path** — when `ExecStartOpts.onChunk` is
 * omitted. A streamed exec deliberately retains nothing (see `onChunk`), so
 * both fields come back empty; consume the chunks instead.
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
}

export interface ExecStartOpts {
	signal?: AbortSignal;
	/**
	 * Per-frame callback. Supplying it switches `execStart` to the streaming
	 * path, which does **not** retain the output — the returned `ExecResult` is
	 * empty. An agent run's raw stream-json transcript reaches hundreds of MB
	 * (every tool result in full, strictly larger than the capped rendered log),
	 * so anything the caller needs from the stream must be derived incrementally
	 * here rather than scanned afterwards.
	 *
	 * Every implementation must honour this, including test fakes: a fake that
	 * returned the transcript would let a test pass against a contract
	 * production does not offer.
	 */
	onChunk?: (chunk: ExecLogChunk) => void | Promise<void>;
}

export interface ContainerMemoryStats {
	usedBytes: number;
	rawUsageBytes: number;
}

export interface ImageInfo {
	Id: string;
	Config: {
		Labels: Record<string, string> | null;
	};
}

export interface NetworkInfo {
	IPAM: {
		Config: Array<{ Gateway?: string; Subnet?: string }> | null;
	} | null;
}

/** One matching process from `listHezoProcesses`'s in-container `/proc` scan. */
export interface ContainerProcessInfo {
	pid: number;
	/** Value of `HEZO_HEARTBEAT_RUN_ID` in the process env, or null when absent. */
	runId: string | null;
	/** Whether the process env carries `SSH_AUTH_SOCK=/run/hezo/…` (legacy bridge-scoped exec). */
	hasHezoSock: boolean;
	/** Seconds since the process started, floored. */
	ageSecs: number;
	/** NUL-joined cmdline rendered with spaces; empty for kernel threads. */
	cmdline: string;
}

/**
 * A bidirectional byte channel to a command running in the container.
 *
 * This is the tunnel's transport, and it is the one place the backends differ
 * in kind rather than in detail: Docker hijacks its exec socket, while a
 * provider may offer only a PTY over a WebSocket. Each renders this shape its
 * own way; the framing and multiplexing above it are shared
 * (`sandbox/tunnel/`), so the network stack still has one shape.
 */
export interface ContainerByteChannel {
	write(data: Uint8Array): void;
	/** Payload bytes from the command's stdout, already demuxed if the transport frames them. */
	onData(handler: (chunk: Uint8Array) => void): void;
	/** Diagnostics from the command's stderr. Never carries protocol bytes. */
	onStderr(handler: (chunk: Uint8Array) => void): void;
	/** The channel is gone. The tunnel treats this as fail-closed. */
	onClose(handler: () => void): void;
	close(): void;
}

/** Env var names the process sweeper and abort path match on. */
export type ProcessEnvMarker = 'HEZO_HEARTBEAT_RUN_ID' | 'HEZO_EXEC_SCOPE_ID';

/**
 * Everything Hezo asks of a container runtime.
 *
 * Implementations: `DockerClient` (production) and `createFakeDockerClient`
 * (tests and `HEZO_SKIP_DOCKER=1`). The fake implements this interface for real
 * rather than being cast to it — a partial stub cast through `unknown` hid
 * missing methods until production code called one and threw.
 */
export interface ContainerEngine {
	ping(): Promise<boolean>;

	imageExists(image: string): Promise<boolean>;
	inspectImage(image: string): Promise<ImageInfo | null>;
	removeImage(image: string, force?: boolean): Promise<void>;
	/** Deliberately un-timeouted: an image pull is legitimately minutes long. */
	pullImage(image: string): Promise<void>;

	inspectNetwork(name: string): Promise<NetworkInfo | null>;

	createContainer(
		name: string,
		config: ContainerConfig,
	): Promise<{ Id: string; Warnings: string[] }>;
	startContainer(containerId: string): Promise<void>;
	stopContainer(containerId: string, timeoutSec?: number): Promise<void>;
	removeContainer(containerId: string, force?: boolean): Promise<void>;
	inspectContainer(containerId: string): Promise<ContainerInfo | null>;
	listContainersByLabel(label: string): Promise<Array<{ Id: string; Names: string[] }>>;
	findContainerByNamePrefix(prefix: string): Promise<ContainerInfo | null>;
	containerStats(containerId: string): Promise<ContainerMemoryStats | null>;
	containerLogs(
		containerId: string,
		opts?: { follow?: boolean; tail?: number; stdout?: boolean; stderr?: boolean },
		signal?: AbortSignal,
	): Promise<Response | null>;

	execCreate(containerId: string, config: ExecConfig): Promise<string>;
	/**
	 * Open a bidirectional byte channel to a command - the tunnel's transport.
	 * Distinct from the exec triad because that path is one-way by construction:
	 * it returns captured output, with no way to write to the command.
	 */
	openExecChannel(containerId: string, config: ExecConfig): Promise<ContainerByteChannel>;
	execStart(execId: string, opts?: ExecStartOpts): Promise<ExecResult>;
	execInspect(execId: string): Promise<{ ExitCode: number; Running: boolean; Pid: number }>;

	killProcessesByEnvMarker(
		containerId: string,
		name: ProcessEnvMarker,
		value: string,
	): Promise<void>;
	killRunProcesses(containerId: string, runId: string): Promise<void>;
	listHezoProcesses(containerId: string): Promise<ContainerProcessInfo[]>;
	killPids(containerId: string, pids: number[]): Promise<void>;

	/**
	 * Bytes used on the filesystem holding `path` inside the container, or null
	 * when it could not be read **or does not describe the container's own
	 * storage**.
	 *
	 * The pool's recycle rung is decided on this: a container near its disk
	 * ceiling is replaced rather than reused, because one that fills up *during* a
	 * run fails that run partway through. That reasoning holds only while the
	 * storage belongs to the container, so a path on a foreign mount - a bind
	 * mount of the host data dir, where replacing the container frees nothing -
	 * answers null rather than the host partition's usage. Null is not zero: an
	 * unanswerable measurement must leave the last known figure alone rather than
	 * report a container as empty.
	 *
	 * A per-engine method rather than an exec at the call site, so a backend that
	 * exposes disk on its control plane can answer without spawning anything -
	 * and so nothing above the seam has to know which one it is talking to.
	 */
	diskUsedBytes(containerId: string, path: string): Promise<number | null>;

	/**
	 * The memory this engine's containers are drawn from, or `null` when they do
	 * not draw on this machine at all.
	 *
	 * The capacity model needs exactly one fact about a backend - whether the RAM
	 * its containers consume is the operator's to spend - and this is that fact,
	 * stated as a resource rather than as a provider. Answering `null` is not
	 * "unknown": it is "not from here", and the budget falls back to a flat
	 * default the operator sets deliberately instead of sizing a remote fleet by
	 * the wrong computer.
	 *
	 * Synchronous and cheap by contract: it reports what the engine is configured
	 * against, not a live measurement, and is read on settings reads and on the
	 * dispatch gate.
	 */
	containerHostMemory(): ContainerHostMemory | null;

	/**
	 * Read and write a run's artefact files, rooted at an absolute path **inside
	 * the container**.
	 *
	 * This is what lets a whole agent run work off the operator's own daemon.
	 * Every artefact a run stages (the prompt file, the per-run runtime home and
	 * its credentials, the tunnel config) and reads back (Grok's debug log,
	 * Kimi's `wire.jsonl`, the auto-push error log) goes through the returned
	 * interface, so nothing above this seam may reach for `node:fs` and quietly
	 * assume a bind mount - a host-only file path is one that works everywhere
	 * except production on a managed backend.
	 *
	 * `containerRoot` is the container-side path, identical on both backends by
	 * rule; only how it is reached differs.
	 */
	files(containerId: string, containerRoot: string): SandboxFiles;
}
