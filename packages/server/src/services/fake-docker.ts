import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '../db/database';
import { hostSandboxFiles, type SandboxFiles } from './sandbox/files';
import type {
	ContainerByteChannel,
	ContainerConfig,
	ContainerEngine,
	ContainerInfo,
	ExecConfig,
	ExecLogChunk,
	ExecResult,
	ExecStartOpts,
} from './sandbox/types';
import { CONTAINER_WORKSPACE_ROOT, getWorkspacePath } from './workspace';

const SYNTHETIC_EXEC_SCRIPT: Array<{
	stream: 'stdout' | 'stderr';
	text: string;
	delayMs?: number;
}> = [
	{ stream: 'stdout', text: '[synthetic] starting agent run\n', delayMs: 10 },
	{ stream: 'stdout', text: '[synthetic] analyzing task\n', delayMs: 10 },
	{ stream: 'stdout', text: '[synthetic] writing response\n', delayMs: 10 },
	{ stream: 'stdout', text: '[synthetic] task complete\n', delayMs: 10 },
];

/**
 * Retains nothing, exactly like the real streaming `execStart` — a fake that
 * returned the transcript would let a test pass against a contract production
 * does not honour.
 */
async function runSyntheticExec(opts: ExecStartOpts): Promise<void> {
	for (const entry of SYNTHETIC_EXEC_SCRIPT) {
		if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
		await opts.onChunk?.(entry as ExecLogChunk);
		if (entry.delayMs) {
			await new Promise((r) => setTimeout(r, entry.delayMs));
		}
	}
}

const RUN_ID_ENV_PREFIX = 'HEZO_HEARTBEAT_RUN_ID=';

interface FakeContainer {
	name: string;
	running: boolean;
	labels: Record<string, string>;
}

/**
 * A happy-path container engine used by tests and any process started with
 * `HEZO_SKIP_DOCKER=1`. All operations succeed; agent execs emit a short
 * deterministic synthetic script so log streams behave like real runs.
 *
 * The synthetic exec stands in for an agent doing real work, so — like a real
 * run that makes an MCP write — it marks its run as having produced output.
 * Without this the completion path would treat every synthetic run as a no-op
 * and fail it. Pass `db` to enable; omit it for pure engine-surface stubs.
 *
 * This **implements `ContainerEngine`** rather than being cast to it. The old
 * `as unknown as DockerClient` cast let the stub omit methods silently, and
 * production code that called one (`inspectImage` from the startup image prune,
 * `listContainersByLabel` from uninstall, `findContainerByNamePrefix` from the
 * boot self-heal) threw "is not a function" at runtime under `HEZO_SKIP_DOCKER`.
 * The compiler now rejects an incomplete stub.
 */
export function createFakeDockerClient(db?: Db, dataDir?: string): ContainerEngine {
	const containers = new Map<string, FakeContainer>();
	const execRunIds = new Map<string, string | null>();
	let execCounter = 0;
	const tunnelReadyExecs = new Set<string>();

	const describe = (id: string): ContainerInfo => {
		const running = containers.get(id)?.running ?? true;
		return {
			Id: id,
			State: {
				Status: running ? 'running' : 'exited',
				Running: running,
				Pid: running ? 1 : 0,
				ExitCode: 0,
			},
			Config: { Image: 'noop' },
		};
	};

	return {
		// The fake stands in for a local daemon, which does route back to the host.
		ping: async () => true,

		imageExists: async () => true,
		/**
		 * Null, so `pruneStaleBundledImages` treats every bundled image as
		 * not-installed and skips it (`if (!info) continue`). A fake has no real
		 * layers to be stale against, so pruning is a clean no-op.
		 */
		inspectImage: async () => null,
		removeImage: async () => {},
		pullImage: async () => {},

		inspectNetwork: async () => ({ IPAM: { Config: [{ Gateway: '172.17.0.1' }] } }),

		// `config` optional for the same reason as `execCreate` below.
		createContainer: async (name: string, config?: ContainerConfig) => {
			const id = `noop-${name}`;
			containers.set(id, { name, running: false, labels: config?.Labels ?? {} });
			recordFakeBinds(id, config?.HostConfig?.Binds);
			return { Id: id, Warnings: [] };
		},
		startContainer: async (id: string) => {
			const c = containers.get(id) ?? { name: id, running: false, labels: {} };
			c.running = true;
			containers.set(id, c);
		},
		stopContainer: async (id: string) => {
			const c = containers.get(id);
			if (c) c.running = false;
		},
		removeContainer: async (id: string) => {
			containers.delete(id);
		},
		inspectContainer: async (id: string) => describe(id),
		listContainersByLabel: async (label: string) =>
			[...containers.entries()]
				.filter(([, c]) => label in c.labels)
				.map(([id, c]) => ({ Id: id, Names: [`/${c.name}`] })),
		findContainerByNamePrefix: async (prefix: string) => {
			for (const [id, c] of containers) {
				if (c.name.startsWith(prefix)) return describe(id);
			}
			return null;
		},
		// A container that is comfortably under any limit. Omitting this made the
		// container-sync memory check throw `containerStats is not a function` on
		// every pass under HEZO_SKIP_DOCKER - a warning on a green run, and worse,
		// `enforceContainerMemoryLimit` never actually ran in any harness that
		// uses the fake, so nothing exercised it.
		containerStats: async (id: string) =>
			containers.has(id) ? { usedBytes: 64 * 1024 * 1024, rawUsageBytes: 96 * 1024 * 1024 } : null,
		containerLogs: async () => new Response(new Uint8Array()),

		// `config` is optional here though `ContainerEngine` requires it (a looser
		// parameter is still a valid implementation). Callers in tests exercise the
		// surface without building a full exec config, and a fake has no reason to
		// be stricter than its callers need.
		execCreate: async (_id: string, config?: ExecConfig) => {
			const execId = `noop-exec-${++execCounter}`;
			const runEntry = config?.Env?.find((e) => e.startsWith(RUN_ID_ENV_PREFIX));
			execRunIds.set(execId, runEntry ? runEntry.slice(RUN_ID_ENV_PREFIX.length) : null);
			// The tunnel's port-readiness check, recognised so it can be answered.
			// `startRunTunnel` will not hand a run its endpoints until the client's
			// ports are listening, so a fake that never answers leaves every run -
			// and every chat turn - waiting out the full timeout and then failing.
			if ((config?.Cmd ?? []).some((part) => part.includes('/proc/net/tcp'))) {
				tunnelReadyExecs.add(execId);
			}
			return execId;
		},
		execStart: async (execId: string, opts?: ExecStartOpts): Promise<ExecResult> => {
			const runId = execRunIds.get(execId) ?? null;
			execRunIds.delete(execId);
			// A fake container's tunnel comes up. A test that wants the opposite
			// drives `startRunTunnel` against its own engine (sandbox-run-tunnel).
			if (tunnelReadyExecs.delete(execId)) return { stdout: 'ready\n', stderr: '' };
			if (!opts?.onChunk) return { stdout: '', stderr: '' };
			await runSyntheticExec(opts);
			if (db && runId) {
				await db.query('UPDATE heartbeat_runs SET produced_output = true WHERE id = $1', [runId]);
			}
			return { stdout: '', stderr: '' };
		},
		execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
		// A channel that carries nothing and closes on demand. The tunnel treats a
		// closed channel as fail-closed, so a HEZO_SKIP_DOCKER run simply never
		// tunnels rather than hanging waiting for bytes that will not come.
		openExecChannel: async (): Promise<ContainerByteChannel> => {
			let onClose: (() => void) | undefined;
			return {
				write: () => {},
				onData: () => {},
				onStderr: () => {},
				onClose: (handler) => {
					onClose = handler;
				},
				close: () => onClose?.(),
			};
		},

		killProcessesByEnvMarker: async () => {},
		killRunProcesses: async () => {},
		// Empty scan = the startup dangling-process sweep is a clean no-op in
		// every HEZO_SKIP_DOCKER harness.
		listHezoProcesses: async () => [],
		killPids: async () => {},
		// No real filesystem quota behind the fake, so it reports "could not tell"
		// rather than 0 - a fake claiming an empty disk would make the pool's
		// recycle rung untestable by asserting the opposite of what it guards.
		diskUsedBytes: async () => null,

		// Resolved through the container's bind mounts, exactly as Docker would.
		// The fake exists to stand in for a *local daemon*, and a local daemon's
		// defining property here is that a path written inside the container is the
		// same bytes on the host - which is what lets a test stage a file through
		// the seam and read it back off disk. An in-memory store would quietly
		// break every such assertion while looking like it worked.
		files: (containerId: string, containerRoot: string) =>
			lazyHostFiles(() => resolveFakeHostRoot(containerId, containerRoot, db, dataDir)),
	};
}

/**
 * Container-path -> host-path bind tables, per container.
 *
 * Populated from `HostConfig.Binds` at create, which is the same information
 * Docker itself is given, so the fake's file view matches the real one without
 * anything having to be declared twice.
 */
const fakeBinds = new Map<string, Array<{ containerPath: string; hostPath: string }>>();

/** Fallback roots for containers a test fabricates without going through create. */
const fakeFallbackRoots = new Map<string, string>();

export function recordFakeBinds(containerId: string, binds?: string[]): void {
	if (!binds?.length) return;
	const parsed = binds
		.map((bind) => {
			const [hostPath, containerPath] = bind.split(':');
			return hostPath && containerPath ? { containerPath, hostPath } : null;
		})
		.filter((entry): entry is { containerPath: string; hostPath: string } => entry !== null)
		// Longest container path first, so a nested mount wins over its parent.
		.sort((a, b) => b.containerPath.length - a.containerPath.length);
	fakeBinds.set(containerId, parsed);
}

/**
 * Register where a container root lives on the host for a container the test
 * never created through the engine - the common shape, where a project row is
 * given a `container_id` directly.
 */
export function registerFakeContainerRoot(containerId: string, hostRoot: string): void {
	fakeFallbackRoots.set(containerId, hostRoot);
}

/**
 * A {@link SandboxFiles} whose host root is resolved on first use.
 *
 * `files()` is synchronous by the interface's contract, but the fake resolves
 * its root from the database - so the lookup is deferred into the operations,
 * which are async anyway.
 */
function lazyHostFiles(resolve: () => Promise<string>): SandboxFiles {
	const bound = async (): Promise<SandboxFiles> => hostSandboxFiles(await resolve());
	return {
		exists: async (p) => (await bound()).exists(p),
		read: async (p) => (await bound()).read(p),
		readBytes: async (p) => (await bound()).readBytes(p),
		size: async (p) => (await bound()).size(p),
		remove: async (p) => (await bound()).remove(p),
		removeDir: async (p) => (await bound()).removeDir(p),
		findByName: async (d, n, depth) => (await bound()).findByName(d, n, depth),
		write: async (p, c, o) => (await bound()).write(p, c, o),
		writeBytes: async (p, c, o) => (await bound()).writeBytes(p, c, o),
		mkdir: async (p, o) => (await bound()).mkdir(p, o),
	};
}

async function resolveFakeHostRoot(
	containerId: string,
	containerRoot: string,
	db?: Db,
	dataDir?: string,
): Promise<string> {
	const suffix = (base: string): string =>
		containerRoot.startsWith(CONTAINER_WORKSPACE_ROOT)
			? `${base}${containerRoot.slice(CONTAINER_WORKSPACE_ROOT.length)}`
			: base;

	// A recorded bind is the most faithful answer: it is the same information
	// Docker itself was given at create.
	for (const bind of fakeBinds.get(containerId) ?? []) {
		if (containerRoot === bind.containerPath) return bind.hostPath;
		if (containerRoot.startsWith(`${bind.containerPath}/`)) {
			return `${bind.hostPath}${containerRoot.slice(bind.containerPath.length)}`;
		}
	}

	const registered = fakeFallbackRoots.get(containerId);
	if (registered) return suffix(registered);

	// Most tests hand a project a `container_id` without provisioning through the
	// engine, so there are no binds to read. The project row still says which
	// workspace that container would have mounted, which is the same mapping a
	// real bind produces.
	if (db && dataDir) {
		try {
			const row = await db.query<{ team_id: string; id: string }>(
				'SELECT team_id, id FROM projects WHERE container_id = $1 LIMIT 1',
				[containerId],
			);
			const project = row.rows[0];
			if (project) return suffix(getWorkspacePath(dataDir, project.team_id, project.id));
		} catch {
			// Fall through to the scratch dir below - a fake must never throw from
			// a path resolution.
		}
	}

	// Nothing to go on: a scratch dir, so writes still round-trip rather than
	// failing on a path that does not exist.
	const scratch = join(
		tmpdir(),
		'hezo-fake-container',
		containerId,
		containerRoot.replaceAll('/', '_'),
	);
	mkdirSync(scratch, { recursive: true });
	return scratch;
}
