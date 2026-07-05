import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Minimal docker-daemon simulator on a unix socket, for exercising the real
// DockerClient transport (fetch for one-shot calls, node:http for the
// long-lived streams) in both the vitest (Node) and Bun-native tiers. It
// implements just the streaming endpoints: exec start and container logs,
// answering with docker's stdout/stderr multiplex framing.

/** One scripted stdout/stderr frame, optionally delayed. */
export interface SimFrame {
	stream: 'stdout' | 'stderr';
	text: string;
	delayMs?: number;
}

export interface SimScenario {
	/** HTTP status for the response (default 200). Non-200 sends `body` as text. */
	status?: number;
	body?: string;
	frames?: SimFrame[];
	/** Keep the response open after the last frame instead of ending it. */
	hangAfterFrames?: boolean;
}

/** Encode one docker multiplex frame (8-byte header + payload). */
export function muxFrame(stream: 'stdout' | 'stderr', text: string): Buffer {
	const payload = Buffer.from(text, 'utf8');
	const header = Buffer.alloc(8);
	header[0] = stream === 'stderr' ? 2 : 1;
	header.writeUInt32BE(payload.length, 4);
	return Buffer.concat([header, payload]);
}

export interface DockerSockSim {
	socketPath: string;
	/** Script the response for POST /exec/<execId>/start. */
	onExecStart(execId: string, scenario: SimScenario): void;
	/** Script the response for GET /containers/<containerId>/logs. */
	onContainerLogs(containerId: string, scenario: SimScenario): void;
	close(): Promise<void>;
}

export async function startDockerSockSim(): Promise<DockerSockSim> {
	const socketPath = join(tmpdir(), `docker-sim-${randomBytes(6).toString('hex')}.sock`);
	const execScenarios = new Map<string, SimScenario>();
	const logScenarios = new Map<string, SimScenario>();
	const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

	const server: Server = createServer(async (req, res) => {
		const url = req.url ?? '';
		const execMatch = url.match(/^\/v[\d.]+\/exec\/([^/]+)\/start$/);
		const logsMatch = url.match(/^\/v[\d.]+\/containers\/([^/]+)\/logs\?/);
		const scenario = execMatch
			? execScenarios.get(execMatch[1])
			: logsMatch
				? logScenarios.get(logsMatch[1])
				: undefined;
		if (!scenario) {
			res.writeHead(404, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ message: 'no such exec/container' }));
			return;
		}
		// Drain the request body before answering (exec start POSTs JSON).
		for await (const _chunk of req) {
			// discard
		}
		if (scenario.status && scenario.status !== 200) {
			res.writeHead(scenario.status, { 'Content-Type': 'text/plain' });
			res.end(scenario.body ?? 'simulated error');
			return;
		}
		res.writeHead(200, { 'Content-Type': 'application/vnd.docker.raw-stream' });
		for (const frame of scenario.frames ?? []) {
			if (frame.delayMs) await sleep(frame.delayMs);
			res.write(muxFrame(frame.stream, frame.text));
		}
		if (!scenario.hangAfterFrames) res.end();
	});

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(socketPath, () => resolve());
	});

	return {
		socketPath,
		onExecStart: (execId, scenario) => execScenarios.set(execId, scenario),
		onContainerLogs: (containerId, scenario) => logScenarios.set(containerId, scenario),
		close: () =>
			new Promise<void>((resolve) => {
				// Outstanding hung streams keep close() pending; destroy them via
				// closeAllConnections so teardown is prompt.
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
