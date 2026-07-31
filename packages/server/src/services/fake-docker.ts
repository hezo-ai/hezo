import type { Db } from '../db/database';
import type {
	ContainerConfig,
	ContainerEngine,
	ContainerInfo,
	ExecConfig,
	ExecLogChunk,
	ExecResult,
	ExecStartOpts,
} from './sandbox/types';

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
export function createFakeDockerClient(db?: Db): ContainerEngine {
	const containers = new Map<string, FakeContainer>();
	const execRunIds = new Map<string, string | null>();
	let execCounter = 0;

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
			return execId;
		},
		execStart: async (execId: string, opts?: ExecStartOpts): Promise<ExecResult> => {
			const runId = execRunIds.get(execId) ?? null;
			execRunIds.delete(execId);
			if (!opts?.onChunk) return { stdout: '', stderr: '' };
			await runSyntheticExec(opts);
			if (db && runId) {
				await db.query('UPDATE heartbeat_runs SET produced_output = true WHERE id = $1', [runId]);
			}
			return { stdout: '', stderr: '' };
		},
		execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),

		killProcessesByEnvMarker: async () => {},
		killRunProcesses: async () => {},
		// Empty scan = the startup dangling-process sweep is a clean no-op in
		// every HEZO_SKIP_DOCKER harness.
		listHezoProcesses: async () => [],
		killPids: async () => {},
	};
}
