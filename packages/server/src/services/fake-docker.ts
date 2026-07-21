import type { Db } from '../db/database';
import type { DockerClient, ExecLogChunk, ExecStartOpts } from './docker';

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

async function runSyntheticExec(opts: ExecStartOpts): Promise<{ stdout: string; stderr: string }> {
	let stdoutAcc = '';
	let stderrAcc = '';
	for (const entry of SYNTHETIC_EXEC_SCRIPT) {
		if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
		if (entry.stream === 'stdout') stdoutAcc += entry.text;
		else stderrAcc += entry.text;
		await opts.onChunk?.(entry as ExecLogChunk);
		if (entry.delayMs) {
			await new Promise((r) => setTimeout(r, entry.delayMs));
		}
	}
	return { stdout: stdoutAcc, stderr: stderrAcc };
}

const RUN_ID_ENV_PREFIX = 'HEZO_HEARTBEAT_RUN_ID=';

/**
 * A happy-path Docker stub used by tests and any process started with
 * `HEZO_SKIP_DOCKER=1`. All operations succeed; agent execs emit a short
 * deterministic synthetic script so log streams behave like real runs.
 *
 * The synthetic exec stands in for an agent doing real work, so — like a real
 * run that makes an MCP write — it marks its run as having produced output.
 * Without this the completion path would treat every synthetic run as a no-op
 * and fail it. Pass `db` to enable; omit it for pure docker-surface stubs.
 */
export function createFakeDockerClient(db?: Db): DockerClient {
	const containers = new Map<string, { running: boolean }>();
	const execRunIds = new Map<string, string | null>();
	let execCounter = 0;

	const stub = {
		ping: async () => true,
		imageExists: async () => true,
		pullImage: async () => {},
		createContainer: async (name: string) => {
			const id = `noop-${name}`;
			containers.set(id, { running: false });
			return { Id: id, Warnings: [] };
		},
		startContainer: async (id: string) => {
			const c = containers.get(id) ?? { running: false };
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
		inspectNetwork: async () => ({ IPAM: { Config: [{ Gateway: '172.17.0.1' }] } }),
		inspectContainer: async (id: string) => {
			const c = containers.get(id);
			const running = c?.running ?? true;
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
		},
		containerLogs: async () => new Response(new Uint8Array()),
		execCreate: async (_id: string, config?: { Env?: string[] }) => {
			const execId = `noop-exec-${++execCounter}`;
			const runEntry = config?.Env?.find((e) => e.startsWith(RUN_ID_ENV_PREFIX));
			execRunIds.set(execId, runEntry ? runEntry.slice(RUN_ID_ENV_PREFIX.length) : null);
			return execId;
		},
		execStart: async (
			execId: string,
			opts?: ExecStartOpts,
		): Promise<{ stdout: string; stderr: string }> => {
			const runId = execRunIds.get(execId) ?? null;
			execRunIds.delete(execId);
			if (!opts?.onChunk) return { stdout: '', stderr: '' };
			const result = await runSyntheticExec(opts);
			if (db && runId) {
				await db.query('UPDATE heartbeat_runs SET produced_output = true WHERE id = $1', [runId]);
			}
			return result;
		},
		execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
		killRunProcesses: async () => {},
		killProcessesByEnvMarker: async () => {},
		// Empty scan = the startup dangling-process sweep is a clean no-op in
		// every HEZO_SKIP_DOCKER harness.
		listHezoProcesses: async () => [],
		killPids: async () => {},
	};
	return stub as unknown as DockerClient;
}
