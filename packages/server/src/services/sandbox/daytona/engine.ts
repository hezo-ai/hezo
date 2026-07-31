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
} from '../types';
import { type DaytonaApi, DaytonaApiError, type DaytonaSandbox } from './client';
import { renderDaytonaExec, renderStderrDrain } from './command';

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
		return { Id: sandbox.id, Warnings: [] };
	}

	async startContainer(containerId: string): Promise<void> {
		const sandbox = await this.fetch(containerId);
		// Unlike Docker, create leaves the sandbox running - starting a started
		// sandbox is an error there, so the state check is required rather than
		// an optimization.
		if (sandbox && isRunning(sandbox.state)) return;
		await this.client.start(containerId);
		this.sandboxes.delete(containerId);
	}

	async stopContainer(containerId: string): Promise<void> {
		await this.client.stop(containerId);
		this.sandboxes.delete(containerId);
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

function isRunning(state: string): boolean {
	return state === 'started';
}

function isFailed(state: string): boolean {
	return state === 'error' || state === 'build_failed';
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
