import { randomBytes } from 'node:crypto';
import { logger } from '../../../logger';
import { parseHezoProcessList } from '../../docker';
import { resolveDigestPinnedRef } from '../image-ref';
import {
	buildKillByEnvMarkerScript,
	buildKillPidsScript,
	buildListHezoProcessesScript,
} from '../proc-scripts';
import type {
	ContainerByteChannel,
	ContainerConfig,
	ContainerEngine,
	ContainerInfo,
	ContainerMemoryStats,
	ContainerProcessInfo,
	ExecConfig,
	ExecResult,
	ExecStartOpts,
	ImageInfo,
	NetworkInfo,
	ProcessEnvMarker,
	SandboxFiles,
} from '../types';
import { type DaytonaApi, DaytonaApiError, type DaytonaSandbox } from './client';
import { renderDaytonaExec, renderDaytonaExecScript, renderStderrDrain } from './command';
import { daytonaSandboxFiles } from './files';

const log = logger.child('daytona-engine');

/**
 * Labels Hezo stamps on every sandbox it creates.
 *
 * Daytona has no notion of a container name or of the image a sandbox was built
 * from once the build is done, so both are carried as labels. That is what lets
 * `findContainerByNamePrefix` and `inspectContainer().Config.Image` answer the
 * same questions they answer on Docker.
 */
const NAME_LABEL = 'hezo.name';
const IMAGE_LABEL = 'hezo.image';

/** Disk (GB) requested per sandbox. The image is a read-only lower layer and does not count against it. */
const DEFAULT_DISK_GB = 10;
/** vCPU per sandbox. */
const DEFAULT_CPU = 2;

/** Bound on a single exec's stderr read-back. */
const STDERR_TAIL_BYTES = 256 * 1024;

/**
 * Ceiling on the in-flight exec table.
 *
 * Daytona has no exec handle, so the `execCreate`/`execStart`/`execInspect`
 * triad is reassembled here: `execCreate` records the spec against a minted id
 * and `execInspect` consumes it. Callers that only need the side effect (the
 * `/proc` kills) never inspect, so entries would accumulate without this. The
 * map is insertion-ordered, so eviction drops the oldest - an exec old enough
 * to be evicted has long since run.
 */
const MAX_TRACKED_EXECS = 512;

/** Trailing window queried for memory metrics; the newest point inside it is used. */
const METRICS_WINDOW_MS = 5 * 60_000;

interface TrackedExec {
	containerId: string;
	/** Fully rendered `sh -c '…'` command. */
	command: string;
	stderrPath: string;
	workingDir?: string;
	wantsStdout: boolean;
	wantsStderr: boolean;
	exitCode?: number;
}

/**
 * `ContainerEngine` over Daytona's managed sandboxes.
 *
 * Everything provider-shaped lives here and in its two siblings (`client.ts`,
 * `command.ts`) - no caller above the seam learns that Daytona exists. Four of
 * its API's properties differ from Docker's enough to be worth naming, because
 * each one is a place where a future backend will need its own answer rather
 * than a shared one:
 *
 * 1. **Create starts the sandbox.** There is no created-but-stopped state, so
 *    `startContainer` is a no-op on a sandbox that is already started.
 * 2. **No per-exec user.** Daytona execs as root and ignores a user on the
 *    request (daytonaio/daytona#4309), so a non-root user is rendered as
 *    `runuser` - see `command.ts`.
 * 3. **No stdout/stderr separation.** Recovered by redirecting stderr to a file
 *    per exec and draining it bounded - see `command.ts`.
 * 4. **No image store.** Sandboxes are built from Dockerfile text, so the
 *    image-management methods have nothing to act on and are inert.
 */
export class DaytonaEngine implements ContainerEngine {
	private readonly execs = new Map<string, TrackedExec>();
	/**
	 * Sandbox records, cached because every exec needs the toolbox URL and that
	 * URL is fixed for a sandbox's lifetime. Invalidated explicitly on the
	 * lifecycle transitions that change `state`, and dropped on removal - so it
	 * is scoped to the sandbox's life rather than growing with it.
	 */
	private readonly sandboxes = new Map<string, DaytonaSandbox>();

	constructor(private readonly client: DaytonaApi) {}

	// ---- lifecycle ---------------------------------------------------------

	ping(): Promise<boolean> {
		return this.client.ping();
	}

	async createContainer(
		name: string,
		config: ContainerConfig,
	): Promise<{ Id: string; Warnings: string[] }> {
		const env: Record<string, string> = {};
		for (const entry of config.Env ?? []) {
			const eq = entry.indexOf('=');
			if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
		}
		const memoryGb = config.HostConfig.Memory
			? Math.max(1, Math.ceil(config.HostConfig.Memory / 1024 ** 3))
			: undefined;

		// Daytona keys its build cache on a hash of the Dockerfile *text*, so a
		// tag-pinned reference is byte-identical forever: the key never moves and
		// the provider keeps serving the snapshot it first built. Pinning the
		// digest is what makes that cache correct, not a nicety.
		const image = await resolveDigestPinnedRef(config.Image);

		const sandbox = await this.client.createSandbox({
			dockerfileContent: `FROM ${image}\n`,
			// The *requested* image is recorded, not the resolved digest, so
			// `inspectContainer().Config.Image` answers the same question it
			// answers on Docker.
			labels: { ...config.Labels, [NAME_LABEL]: name, [IMAGE_LABEL]: config.Image },
			env,
			cpu: DEFAULT_CPU,
			memory: memoryGb,
			disk: DEFAULT_DISK_GB,
			// A backstop only: Hezo suspends idle containers itself, and this is
			// what stops a sandbox billing forever if the server dies first.
			autoStopInterval: DAYTONA_IDLE_STOP_MIN,
			// Negative disables auto-delete. A stopped sandbox must survive so it
			// can be resumed with its filesystem intact.
			autoDeleteInterval: -1,
		});
		this.sandboxes.set(sandbox.id, sandbox);
		// Create returns while the sandbox is still `creating`. Docker's create +
		// start hands back something immediately usable, so the wait belongs here
		// rather than at every call site: without it the caller's first
		// `inspectContainer` reads `Running: false` on a sandbox that is merely
		// coming up, and the container-death path fails the run out from under it.
		await this.settle(sandbox.id);
		return { Id: sandbox.id, Warnings: [] };
	}

	async startContainer(containerId: string): Promise<void> {
		// A stop that has been *accepted* but not finished leaves the sandbox in
		// `stopping`, and starting from there is a hard 409 ("Sandbox state change
		// in progress") - measured against the live API. Settling first is what
		// makes stop-then-start work, which is exactly what the chat's resume path
		// and the pool's resume rung both do.
		const settled = await this.settle(containerId);
		// Unlike Docker, create leaves the sandbox running - starting a started
		// sandbox is an error there, so the state check is required rather than
		// an optimization.
		if (settled && isRunning(settled.state)) return;
		await this.client.start(containerId);
		this.sandboxes.delete(containerId);
		await this.settle(containerId);
	}

	async stopContainer(containerId: string): Promise<void> {
		await this.settle(containerId);
		await this.client.stop(containerId);
		this.sandboxes.delete(containerId);
		// Settle on the way out too, so the caller's next `inspectContainer` reads
		// `stopped` rather than the transitional `stopping` - the difference
		// between a suspended container and one that reads as dead.
		await this.settle(containerId);
	}

	async removeContainer(containerId: string): Promise<void> {
		await this.client.destroy(containerId);
		this.sandboxes.delete(containerId);
	}

	async inspectContainer(containerId: string): Promise<ContainerInfo | null> {
		const sandbox = await this.fetch(containerId, { refresh: true });
		if (!sandbox) return null;
		const running = isRunning(sandbox.state);
		return {
			Id: sandbox.id,
			State: {
				Status: dockerStatusFor(sandbox.state),
				Running: running,
				Pid: 0,
				// Daytona reports no exit code. A sandbox that failed is surfaced as
				// a nonzero one so the existing death-detection path reads it the
				// same way it reads a crashed container.
				ExitCode: isFailed(sandbox.state) ? 1 : 0,
			},
			Config: { Image: sandbox.labels?.[IMAGE_LABEL] ?? '' },
		};
	}

	async listContainersByLabel(label: string): Promise<Array<{ Id: string; Names: string[] }>> {
		const eq = label.indexOf('=');
		const filter = eq > 0 ? { [label.slice(0, eq)]: label.slice(eq + 1) } : undefined;
		const { items } = await this.client.listSandboxes(filter);
		// A bare key has no server-side equivalent, so presence is filtered here.
		const key = eq > 0 ? null : label;
		return items
			.filter((s) => (key ? s.labels?.[key] !== undefined : true))
			.map((s) => ({ Id: s.id, Names: [`/${s.labels?.[NAME_LABEL] ?? s.id}`] }));
	}

	async findContainerByNamePrefix(prefix: string): Promise<ContainerInfo | null> {
		const { items } = await this.client.listSandboxes();
		const match = items.find((s) => (s.labels?.[NAME_LABEL] ?? '').startsWith(prefix));
		return match ? this.inspectContainer(match.id) : null;
	}

	/**
	 * Per-sandbox memory, from Daytona's OTEL metrics.
	 *
	 * Returns null when the series is missing or empty, which the caller already
	 * treats as "no reading this tick" - so a sandbox whose metrics have not
	 * landed yet is simply not enforced against, never mistaken for one using
	 * zero.
	 */
	async containerStats(containerId: string): Promise<ContainerMemoryStats | null> {
		try {
			const metrics = await this.client.getMetrics(containerId, METRICS_WINDOW_MS);
			for (const [name, value] of metrics) {
				const n = name.toLowerCase();
				if (n.includes('memory') && !n.includes('limit') && !n.includes('total')) {
					return { usedBytes: value, rawUsageBytes: value };
				}
			}
			return null;
		} catch (e) {
			log.warn(`memory metrics unavailable for ${containerId}: ${(e as Error).message}`);
			return null;
		}
	}

	/**
	 * No provider log stream, and nothing useful in one if there were: PID 1 is
	 * `sleep infinity`, so a container's log is empty by construction. The
	 * content the UI shows is provisioning and lifecycle output Hezo produces
	 * itself, and the caller already handles a null response.
	 */
	async containerLogs(): Promise<Response | null> {
		return null;
	}

	// ---- images and networks ----------------------------------------------

	/**
	 * Daytona builds from Dockerfile text and exposes no image store, so there is
	 * nothing to query, pull or remove. Reporting the image as present is what
	 * keeps `ensureImage` from attempting a pull that has no meaning here; the
	 * build happens at sandbox create, from a digest-pinned `FROM`.
	 */
	async imageExists(): Promise<boolean> {
		return true;
	}

	async inspectImage(): Promise<ImageInfo | null> {
		return null;
	}

	async removeImage(): Promise<void> {}

	async pullImage(): Promise<void> {}

	/** Docker bridge networking has no analogue; the provider supplies its own. */
	async inspectNetwork(): Promise<NetworkInfo | null> {
		return null;
	}

	// ---- exec --------------------------------------------------------------

	async execCreate(containerId: string, config: ExecConfig): Promise<string> {
		const id = `dtn-exec-${randomBytes(8).toString('hex')}`;
		const stderrPath = `/tmp/.hezo-exec-${id}.err`;
		this.track(id, {
			containerId,
			command: renderDaytonaExec({
				cmd: config.Cmd,
				env: config.Env,
				user: config.User,
				stderrPath,
			}),
			stderrPath,
			workingDir: config.WorkingDir,
			wantsStdout: config.AttachStdout,
			wantsStderr: config.AttachStderr,
		});
		return id;
	}

	async execStart(execId: string, opts: ExecStartOpts = {}): Promise<ExecResult> {
		const rec = this.execs.get(execId);
		if (!rec) throw new Error(`unknown exec ${execId}`);
		const sandbox = await this.fetch(rec.containerId);
		if (!sandbox) throw new Error(`sandbox ${rec.containerId} not found`);

		let stdout = '';
		if (opts.onChunk) {
			// Streaming keeps the never-retain contract: chunks are handed straight
			// to the caller and nothing accumulates here.
			const { exitCode } = await this.client.executeStreaming(
				sandbox,
				rec.command,
				(line) => opts.onChunk?.({ stream: 'stdout', text: line }),
				{ cwd: rec.workingDir, signal: opts.signal },
			);
			rec.exitCode = exitCode;
		} else {
			const res = await this.client.execute(sandbox, rec.command, {
				cwd: rec.workingDir,
				signal: opts.signal,
			});
			rec.exitCode = res.exitCode;
			if (rec.wantsStdout) stdout = res.output;
		}

		// stderr is a file rather than a stream (see command.ts), so it is drained
		// once the command has finished. On the streaming path that means stderr
		// arrives as one chunk at the end instead of interleaved - the honest cost
		// of a provider that merges the two streams.
		const stderr = rec.wantsStderr ? await this.drainStderr(sandbox, rec) : '';
		if (stderr && opts.onChunk) await opts.onChunk({ stream: 'stderr', text: stderr });
		return { stdout, stderr: opts.onChunk ? '' : stderr };
	}

	/**
	 * The tunnel's transport on Daytona: a PTY over WebSocket.
	 *
	 * The exec API has no stdin at all, so this is the only bidirectional channel
	 * the provider offers. The PTY merges stdout and stderr - there is no split
	 * to recover here as there is for a normal exec - so `onStderr` never fires
	 * and diagnostics arrive interleaved on `onData`, which is harmless because
	 * the tunnel client writes none.
	 */
	async openExecChannel(containerId: string, config: ExecConfig): Promise<ContainerByteChannel> {
		const sandbox = await this.fetch(containerId);
		if (!sandbox) throw new Error(`sandbox ${containerId} not found`);
		const sessionId = `hezo-chan-${randomBytes(6).toString('hex')}`;
		const pty = await this.client.openPty(sandbox, sessionId);

		// The PTY starts a login shell, so the command is *typed into* it rather
		// than being the process it launched - the inverse of a Docker exec, where
		// the command is the exec. Sent after raw mode is applied by openPty.
		pty.send(
			new TextEncoder().encode(
				`${renderDaytonaExecScript({
					cmd: config.Cmd,
					env: config.Env,
					user: config.User,
					stderrPath: `/tmp/.hezo-chan-${sessionId}.err`,
				})}\n`,
			),
		);

		return {
			write: (data) => pty.send(data),
			onData: (handler) => pty.onData(handler),
			onStderr: () => {},
			onClose: (handler) => pty.onClose(handler),
			close: () => pty.close(),
		};
	}

	async execInspect(execId: string): Promise<{ ExitCode: number; Running: boolean; Pid: number }> {
		const rec = this.execs.get(execId);
		this.execs.delete(execId);
		return { ExitCode: rec?.exitCode ?? 0, Running: false, Pid: 0 };
	}

	private async drainStderr(sandbox: DaytonaSandbox, rec: TrackedExec): Promise<string> {
		try {
			const res = await this.client.execute(
				sandbox,
				renderStderrDrain(rec.stderrPath, STDERR_TAIL_BYTES),
			);
			return res.output;
		} catch (e) {
			// Best-effort: a sandbox that died mid-exec cannot be read back, and
			// losing the diagnostic must not turn into a failed exec on top of it.
			log.warn(`stderr drain failed for ${sandbox.id}: ${(e as Error).message}`);
			return '';
		}
	}

	// ---- process management ------------------------------------------------

	async killProcessesByEnvMarker(
		containerId: string,
		name: ProcessEnvMarker,
		value: string,
	): Promise<void> {
		await this.runScript(containerId, buildKillByEnvMarkerScript(name, value));
	}

	killRunProcesses(containerId: string, runId: string): Promise<void> {
		return this.killProcessesByEnvMarker(containerId, 'HEZO_HEARTBEAT_RUN_ID', runId);
	}

	async listHezoProcesses(containerId: string): Promise<ContainerProcessInfo[]> {
		const out = await this.runScript(containerId, buildListHezoProcessesScript());
		return parseHezoProcessList(out);
	}

	async killPids(containerId: string, pids: number[]): Promise<void> {
		if (pids.length === 0) return;
		await this.runScript(containerId, buildKillPidsScript(pids));
	}

	/**
	 * {@link SandboxFiles} over the toolbox file API, rooted inside the sandbox.
	 *
	 * There is no bind mount here, so this is the only way a run's artefacts reach
	 * the container at all - the prompt file, the runtime home and its
	 * credentials, the tunnel config - and the only way its read-backs come out
	 * again. The sandbox record is resolved once per call rather than per
	 * operation: the toolbox base is per-sandbox, and looking it up on every read
	 * would add a control-plane round trip to something that already costs one.
	 */
	files(containerId: string, containerRoot: string): SandboxFiles {
		const load = async (): Promise<DaytonaSandbox> => {
			const sandbox = await this.fetch(containerId);
			if (!sandbox) throw new Error(`sandbox ${containerId} not found`);
			return sandbox;
		};
		// A thin forwarding shell so each operation resolves the sandbox lazily -
		// `files()` itself is synchronous by the interface's contract, and the
		// sandbox may not be fetched yet when the caller asks for it.
		const bound = async (): Promise<SandboxFiles> =>
			daytonaSandboxFiles(this.client, await load(), containerRoot);
		return {
			exists: async (relPath: string) => (await bound()).exists(relPath),
			read: async (relPath: string) => (await bound()).read(relPath),
			remove: async (relPath: string) => (await bound()).remove(relPath),
			removeDir: async (relPath: string) => (await bound()).removeDir(relPath),
			findByName: async (relDir: string, name: string, maxDepth: number) =>
				(await bound()).findByName(relDir, name, maxDepth),
			write: async (
				relPath: string,
				contents: string,
				opts?: { mode?: number; dirMode?: number },
			) => (await bound()).write(relPath, contents, opts),
			mkdir: async (relPath: string, opts?: { mode?: number }) =>
				(await bound()).mkdir(relPath, opts),
		};
	}

	/**
	 * Run one of the shared `/proc` scripts. They run as root, which is Daytona's
	 * default exec identity, so no elevation is requested - the scripts are
	 * identical to the ones the Docker engine runs.
	 */
	private async runScript(containerId: string, script: string): Promise<string> {
		const sandbox = await this.fetch(containerId);
		if (!sandbox) return '';
		const res = await this.client.execute(sandbox, `sh -c ${shQuote(script)}`);
		return res.output;
	}

	// ---- internals ---------------------------------------------------------

	private track(id: string, rec: TrackedExec): void {
		if (this.execs.size >= MAX_TRACKED_EXECS) {
			const oldest = this.execs.keys().next();
			if (!oldest.done) this.execs.delete(oldest.value);
		}
		this.execs.set(id, rec);
	}

	/**
	 * Wait for a sandbox to reach a resting state.
	 *
	 * Daytona's lifecycle calls return when the transition has been **accepted**,
	 * not when it has happened: create answers `creating`, stop answers
	 * `stopping`, and both settle a beat later (measured: create -> started in
	 * ~0.7s warm, stop -> stopped in ~1.1s). Docker's equivalents do not behave
	 * that way, so absorbing the difference is this adapter's job - leaking it
	 * upward produced two real failures: a 409 on stop-then-start, and a
	 * just-created sandbox reading `Running: false` to the container-death path.
	 *
	 * Unknown states are treated as **transitional**, deliberately. A new
	 * transitional state that we proceeded through would resurface as the 409 this
	 * exists to remove, whereas a new resting state costs one bounded wait and
	 * logs itself, which is how we would find out about it.
	 */
	private async settle(
		containerId: string,
		timeoutMs = SETTLE_TIMEOUT_MS,
	): Promise<DaytonaSandbox | null> {
		const deadline = Date.now() + timeoutMs;
		let sandbox = await this.fetch(containerId, { refresh: true });
		while (sandbox && !isSettled(sandbox.state)) {
			if (Date.now() >= deadline) {
				log.warn(
					`sandbox ${containerId} still in state "${sandbox.state}" after ${timeoutMs}ms; proceeding`,
				);
				return sandbox;
			}
			await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
			sandbox = await this.fetch(containerId, { refresh: true });
		}
		return sandbox;
	}

	private async fetch(
		containerId: string,
		opts: { refresh?: boolean } = {},
	): Promise<DaytonaSandbox | null> {
		if (!opts.refresh) {
			const cached = this.sandboxes.get(containerId);
			if (cached) return cached;
		}
		try {
			const sandbox = await this.client.getSandbox(containerId);
			if (sandbox) this.sandboxes.set(containerId, sandbox);
			else this.sandboxes.delete(containerId);
			return sandbox;
		} catch (e) {
			if (e instanceof DaytonaApiError && e.status === 404) {
				this.sandboxes.delete(containerId);
				return null;
			}
			throw e;
		}
	}
}

/** Kept local so `command.ts` stays the only place that renders an *exec*. */
function shQuote(s: string): string {
	return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * Minutes of inactivity after which Daytona stops a sandbox on its own.
 *
 * Deliberately looser than Hezo's own fixed idle window: this is the backstop
 * for a server that died holding sandboxes, not the mechanism. If it were equal
 * the provider could stop a container in the same moment Hezo was handing it to
 * the next run.
 */
const DAYTONA_IDLE_STOP_MIN = 10;

/**
 * How long a lifecycle call waits for the sandbox to reach a resting state, and
 * how often it asks. Generous because a *cold* create builds the image (~31s
 * measured) while a warm one settles in well under a second; the poll is only
 * paid while something is actually in flight.
 */
const SETTLE_TIMEOUT_MS = 180_000;
const SETTLE_POLL_MS = 500;

function isRunning(state: string): boolean {
	return state === 'started';
}

function isFailed(state: string): boolean {
	return state === 'error' || state === 'build_failed';
}

/**
 * Resting states - the ones Daytona stays in until something asks it to move.
 * Everything else (`creating`, `starting`, `stopping`, `restoring`, …) is a
 * transition in flight; see {@link DaytonaEngine.settle} for why the unknown
 * case falls on the transitional side.
 */
function isSettled(state: string): boolean {
	return (
		isRunning(state) ||
		isFailed(state) ||
		state === 'stopped' ||
		state === 'destroyed' ||
		state === 'archived'
	);
}

/**
 * Map a Daytona state onto the Docker status string the rest of Hezo branches
 * on. Only `running` and `exited` carry meaning downstream; the transitional
 * states report as `created` so a sandbox mid-start is never mistaken for a
 * dead one and failed out from under its run.
 */
function dockerStatusFor(state: string): string {
	if (isRunning(state)) return 'running';
	if (isFailed(state)) return 'exited';
	switch (state) {
		case 'stopped':
		case 'paused':
		case 'archived':
		case 'destroyed':
			return 'exited';
		default:
			return 'created';
	}
}
