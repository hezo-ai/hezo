import type { DockerClient, ExecLogChunk, ExecStartOpts } from '../../services/docker';

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

/**
 * A happy-path Docker stub used by tests and any process started with
 * `HEZO_SKIP_DOCKER=1`. All operations succeed; agent execs emit a short
 * deterministic synthetic script so log streams behave like real runs.
 */
export function createFakeDockerClient(): DockerClient {
	const containers = new Map<string, { running: boolean }>();

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
		execCreate: async () => 'noop-exec',
		execStart: async (
			_id: string,
			opts?: ExecStartOpts,
		): Promise<{ stdout: string; stderr: string }> => {
			if (!opts?.onChunk) return { stdout: '', stderr: '' };
			return runSyntheticExec(opts);
		},
		execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
	};
	return stub as unknown as DockerClient;
}
