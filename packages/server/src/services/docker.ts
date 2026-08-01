import { request as httpRequest } from 'node:http';
import type { Socket } from 'node:net';
import { connect as netConnect } from 'node:net';
import { Readable } from 'node:stream';
import { DockerFrameDecoder, demuxDockerStream } from './docker-frames';
import type { SandboxFiles } from './sandbox/files';
import {
	buildDiskUsageScript,
	buildKillByEnvMarkerScript,
	buildKillPidsScript,
	buildListHezoProcessesScript,
} from './sandbox/proc-scripts';
import { tarSingleFile, untarFirstFile } from './sandbox/tar';
import { DockerBinaryFrameDecoder } from './sandbox/tunnel/docker-frames-binary';
import type {
	ContainerByteChannel,
	ContainerConfig,
	ContainerEngine,
	ContainerInfo,
	ContainerMemoryStats,
	ContainerProcessInfo,
	ExecConfig,
	ExecLogChunk,
	ExecResult,
	ExecStartOpts,
	ImageInfo,
	NetworkInfo,
	ProcessEnvMarker,
} from './sandbox/types';

// The shared shapes live in the engine seam (`sandbox/types.ts`); re-exported
// here so the many existing `from './docker'` type imports keep resolving.
export type {
	ContainerByteChannel,
	ContainerConfig,
	ContainerEngine,
	ContainerInfo,
	ContainerMemoryStats,
	ContainerProcessInfo,
	ExecConfig,
	ExecLogChunk,
	ExecResult,
	ExecStartOpts,
	ImageInfo,
	NetworkInfo,
	ProcessEnvMarker,
} from './sandbox/types';

const SOCKET_PATH = '/var/run/docker.sock';
/** Cap on a hijack response's header block - a daemon that never terminates them is broken, not slow. */
const MAX_HIJACK_HEADER_BYTES = 64 * 1024;

const API_VERSION = 'v1.44';

/**
 * Hard ceiling for docker daemon calls made by the cron-driven sync loop.
 * A wedged Unix-socket fetch would otherwise stall the container-sync iteration
 * indefinitely. Override via DOCKER_REQUEST_TIMEOUT_MS to widen for slow hosts.
 */
const DEFAULT_DOCKER_REQUEST_TIMEOUT_MS = 10_000;
const DOCKER_REQUEST_TIMEOUT_MS = (() => {
	const raw = process.env.DOCKER_REQUEST_TIMEOUT_MS;
	if (!raw) return DEFAULT_DOCKER_REQUEST_TIMEOUT_MS;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DOCKER_REQUEST_TIMEOUT_MS;
})();

/**
 * Upper bound on the run-process kill exec (`killRunProcesses`). The kill loop
 * scans `/proc` once and returns in well under a second; this ceiling only
 * guards against a wedged daemon so an abort's cleanup can never hang.
 */
const KILL_EXEC_TIMEOUT_MS = 5_000;

/**
 * Upper bound on the boot sweep's `/proc` scan exec (`listHezoProcesses`).
 * Wider than the kill bound — the scan walks every pid — but still short enough
 * that a wedged daemon can't stall startup reconciliation.
 */
const SWEEP_EXEC_TIMEOUT_MS = 10_000;

/**
 * Bound on the container control calls (create/start/stop/remove/exec-create and
 * the label listing). #186 timed out the three sync-loop calls; these had none at
 * all, so a wedged daemon hung them forever - and they sit on the provisioning
 * and run-launch paths, where a hang is indistinguishable from a slow start.
 * Generous rather than tight: creating and starting a container is legitimately
 * slower than an inspect. `pullImage` is deliberately excluded - an image pull is
 * legitimately minutes long - as are the streaming calls, which carry their own
 * per-call signals.
 */
const DOCKER_CONTROL_TIMEOUT_MS = 60_000;

interface RawContainerStats {
	memory_stats?: {
		usage?: number;
		stats?: {
			inactive_file?: number;
			total_inactive_file?: number;
			cache?: number;
		};
	};
}

async function parseJsonOrThrow<T>(res: Response, op: string): Promise<T> {
	const text = await res.text();
	if (text.trim() === '') {
		throw new Error(`Docker ${op} returned empty body (status=${res.status})`);
	}
	try {
		return JSON.parse(text) as T;
	} catch (err) {
		const snippet = text.length > 200 ? `${text.slice(0, 200)}…` : text;
		throw new Error(`Docker ${op} returned non-JSON (status=${res.status}): ${snippet}`, {
			cause: err,
		});
	}
}

/** Reject a relative path that would escape the run root, matching every SandboxFiles implementation. */
function resolveContainerPath(root: string, relPath: string): string {
	if (relPath.startsWith('/')) {
		throw new Error(`sandbox file path must be relative: ${JSON.stringify(relPath)}`);
	}
	const parts: string[] = [];
	for (const segment of relPath.split('/')) {
		if (segment === '' || segment === '.') continue;
		if (segment === '..') {
			if (parts.length === 0) {
				throw new Error(`sandbox file path escapes its root: ${JSON.stringify(relPath)}`);
			}
			parts.pop();
			continue;
		}
		parts.push(segment);
	}
	return parts.length === 0 ? root : `${root}/${parts.join('/')}`;
}

/** Single-quote for `sh -c`, closing and reopening around any embedded quote. */
function shellQuote(arg: string): string {
	return `'${arg.replaceAll("'", `'\\''`)}'`;
}

export class DockerClient implements ContainerEngine {
	private socketPath: string;

	constructor(socketPath = SOCKET_PATH) {
		this.socketPath = socketPath;
	}

	private async request(
		method: string,
		path: string,
		body?: unknown,
		signal?: AbortSignal,
	): Promise<Response> {
		const url = `http://localhost/${API_VERSION}${path}`;
		// `unix` is a Bun-runtime fetch option; cast so type-checkers without
		// Bun's lib (e.g. the web package, which imports this for in-process tests)
		// accept it. Bun reads it at runtime regardless of the static type.
		const res = await fetch(url, {
			method,
			headers: body ? { 'Content-Type': 'application/json' } : undefined,
			body: body ? JSON.stringify(body) : undefined,
			unix: this.socketPath,
			signal,
		} as RequestInit & { unix: string });
		return res;
	}

	/**
	 * Raw-bytes request, for the archive endpoints.
	 *
	 * Separate from {@link request} because that one is a JSON helper: it
	 * `JSON.stringify`s whatever it is given and labels it `application/json`, so
	 * handing it a tar produced `{"0":31,"1":139,…}` and a 500 from the daemon
	 * that named nothing. A binary body needs its own path rather than a flag, so
	 * the two can never be confused at a call site.
	 */
	private async requestBinary(method: string, path: string, body?: Uint8Array): Promise<Response> {
		return fetch(`http://localhost/${API_VERSION}${path}`, {
			method,
			headers: body ? { 'Content-Type': 'application/x-tar' } : undefined,
			body: body as BodyInit | undefined,
			unix: this.socketPath,
			signal: AbortSignal.timeout(DOCKER_CONTROL_TIMEOUT_MS),
		} as RequestInit & { unix: string });
	}

	/**
	 * Long-lived streaming requests (exec attach, log follow) go over node:http
	 * instead of fetch. Bun's fetch enforces a hardcoded ~5-minute idle timeout
	 * (oven-sh/bun#5930) that per-request options can't disable, so an exec
	 * stream that stays quiet that long — an agent CLI deep in a tool call that
	 * emits nothing — is torn down mid-run with "The operation timed out." and
	 * the run fails. node:http over the same unix socket applies no idle
	 * timeout. The node response is wrapped back into a web `Response` so
	 * callers parse both transports identically.
	 *
	 * Aborting `signal` destroys the request; a pending or in-flight body read
	 * then rejects with an `AbortError` DOMException (the same shape callers
	 * already handle for an aborted fetch).
	 */
	private requestStream(
		method: string,
		path: string,
		body?: unknown,
		signal?: AbortSignal,
	): Promise<Response> {
		const abortError = () =>
			signal?.reason instanceof Error
				? signal.reason
				: new DOMException('This operation was aborted', 'AbortError');
		return new Promise<Response>((resolve, reject) => {
			if (signal?.aborted) {
				reject(abortError());
				return;
			}
			const payload = body === undefined ? undefined : JSON.stringify(body);
			let cleanupAbort: (() => void) | undefined;
			const req = httpRequest(
				{
					socketPath: this.socketPath,
					path: `/${API_VERSION}${path}`,
					method,
					headers:
						payload === undefined
							? undefined
							: {
									'Content-Type': 'application/json',
									'Content-Length': Buffer.byteLength(payload),
								},
				},
				(res) => {
					// Detach the abort handler when the RESPONSE stream ends — never on the
					// ClientRequest's 'close', which Bun emits prematurely (while the body
					// is still streaming). Removing the handler on that premature event
					// leaves a stalled read with nothing left to tear it down, so a hung
					// exec (e.g. a black-holed git fetch) ignores its timeout and blocks
					// until the connection dies at OS level.
					res.on('close', () => cleanupAbort?.());
					const headers = new Headers();
					for (const [key, value] of Object.entries(res.headers)) {
						if (typeof value === 'string') headers.set(key, value);
						else if (Array.isArray(value)) for (const v of value) headers.append(key, v);
					}
					resolve(
						new Response(Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>, {
							status: res.statusCode ?? 500,
							headers,
						}),
					);
				},
			);
			// Pre-response failures (socket refused, daemon gone) reject here; once
			// the Response has resolved, errors surface through its body stream.
			req.on('error', (err) => reject(err));
			if (signal) {
				const onAbort = () => req.destroy(abortError());
				signal.addEventListener('abort', onAbort, { once: true });
				cleanupAbort = () => signal.removeEventListener('abort', onAbort);
			}
			if (payload !== undefined) req.write(payload);
			req.end();
		});
	}

	/**
	 * Open a **bidirectional** byte channel to an exec.
	 *
	 * This is the tunnel's transport on Docker, and it cannot go through
	 * `requestStream`: that returns a `Response`, which is read-only. Docker
	 * hands out a raw socket instead, via the standard HTTP upgrade dance -
	 * `Connection: Upgrade` / `Upgrade: tcp` makes it answer `101` and Node
	 * emits `upgrade` with the socket explicitly, rather than leaving us to
	 * pull one out from under a parser that still thinks it owns it.
	 *
	 * Stdin is written raw; output arrives in Docker's 8-byte framing (the exec
	 * runs without a TTY on purpose - a TTY gives raw bytes but also line
	 * discipline, which would mangle a framed protocol) and is demuxed at the
	 * byte level, never through the text decoder the run-log stream uses.
	 */
	async openExecChannel(containerId: string, config: ExecConfig): Promise<ContainerByteChannel> {
		const execId = await this.execCreate(containerId, {
			...config,
			AttachStdin: true,
			AttachStdout: true,
			AttachStderr: true,
		});
		const socket = await this.hijackExec(execId);
		const decoder = new DockerBinaryFrameDecoder();
		let onData: ((chunk: Uint8Array) => void) | undefined;
		let onClose: (() => void) | undefined;
		let onStderr: ((chunk: Uint8Array) => void) | undefined;

		socket.on('data', (chunk: Buffer) => {
			for (const frame of decoder.push(new Uint8Array(chunk))) {
				if (frame.stream === 'stdout') onData?.(frame.payload);
				else onStderr?.(frame.payload);
			}
		});
		const finish = () => onClose?.();
		socket.on('end', finish);
		socket.on('close', finish);
		socket.on('error', finish);
		// `hijackExec` hands the socket back **paused**, so the bytes that arrived
		// alongside the response headers could be `unshift`ed without being lost.
		// Attaching a `data` listener only auto-resumes a stream that was never
		// explicitly paused, so this is required rather than tidy: without it the
		// channel connects, the client binds its listeners, and not one frame is
		// ever delivered.
		socket.resume();

		return {
			write: (data) => {
				socket.write(data);
			},
			close: () => {
				socket.destroy();
			},
			onData: (handler) => {
				onData = handler;
			},
			onStderr: (handler) => {
				onStderr = handler;
			},
			onClose: (handler) => {
				onClose = handler;
			},
		};
	}

	/**
	 * Attach to an exec as a raw bidirectional socket.
	 *
	 * **The request is spoken over a plain `node:net` socket rather than through
	 * `node:http`, deliberately.** `http.request`'s `'upgrade'` event is the
	 * obvious way to do this and it is what this used to do - but it only works
	 * under Node. Bun never emits `'upgrade'` for Docker's hijack: it emits
	 * `'response'` with status **101** and routes the framed exec bytes onto the
	 * response stream, where writing back to `res.socket` does not reach the
	 * exec's stdin at all (both measured against a live daemon). Since Bun is the
	 * production runtime, the version built on `'upgrade'` could never have
	 * worked - it rejected every attach with "attach failed (101)".
	 *
	 * A hijack is just "send a request, then own the socket", so owning it
	 * outright removes the divergence instead of branching on it: one code path,
	 * identical on both runtimes, and exercised by
	 * `test/bun/sandbox-tunnel-docker.bun.test.ts` on the runtime that ships.
	 */
	private hijackExec(execId: string): Promise<Socket> {
		return new Promise((resolve, reject) => {
			const payload = Buffer.from(JSON.stringify({ Detach: false, Tty: false }));
			const socket = netConnect({ path: this.socketPath });
			let header = Buffer.alloc(0);

			const onHeaderData = (chunk: Buffer): void => {
				header = Buffer.concat([header, chunk]);
				const end = header.indexOf('\r\n\r\n');
				if (end < 0) {
					// A response that never terminates its headers is a broken daemon,
					// not a slow one; cap it rather than buffering without bound.
					if (header.length > MAX_HIJACK_HEADER_BYTES) {
						socket.destroy();
						reject(new Error('Docker exec attach: response headers too large'));
					}
					return;
				}
				socket.removeListener('data', onHeaderData);
				socket.removeListener('error', onEarlyError);

				const statusLine = header.subarray(0, header.indexOf('\r\n')).toString();
				const status = Number.parseInt(statusLine.split(' ')[1] ?? '', 10);
				// 101 is the hijack; Docker answers 200 for a non-TTY attach on some
				// versions and the stream is identical. Anything else is a refusal,
				// and its body says why.
				if (status !== 101 && status !== 200) {
					const body = header.subarray(end + 4).toString();
					socket.destroy();
					reject(new Error(`Docker exec attach failed (${status}): ${body}`));
					return;
				}

				// Bytes that arrived in the same chunk as the headers are already
				// stream payload. Pause first so `unshift` is legal, then hand them
				// back for the caller's own `data` handler to receive first.
				const rest = header.subarray(end + 4);
				socket.pause();
				if (rest.length > 0) socket.unshift(rest);
				resolve(socket);
			};

			const onEarlyError = (err: Error): void => reject(err);

			socket.on('data', onHeaderData);
			socket.on('error', onEarlyError);
			socket.on('connect', () => {
				socket.write(
					`POST /${API_VERSION}/exec/${execId}/start HTTP/1.1\r\n` +
						`Host: docker\r\n` +
						`Content-Type: application/json\r\n` +
						`Content-Length: ${payload.length}\r\n` +
						`Connection: Upgrade\r\n` +
						`Upgrade: tcp\r\n\r\n`,
				);
				socket.write(payload);
			});
		});
	}

	async ping(): Promise<boolean> {
		try {
			const res = await this.request(
				'GET',
				'/_ping',
				undefined,
				AbortSignal.timeout(DOCKER_REQUEST_TIMEOUT_MS),
			);
			return res.ok;
		} catch {
			return false;
		}
	}

	async imageExists(image: string): Promise<boolean> {
		const res = await this.request('GET', `/images/${encodeURIComponent(image)}/json`);
		if (res.ok) {
			await res.text();
			return true;
		}
		await res.text();
		return false;
	}

	async inspectImage(image: string): Promise<ImageInfo | null> {
		const res = await this.request('GET', `/images/${encodeURIComponent(image)}/json`);
		if (res.status === 404) {
			await res.text();
			return null;
		}
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Docker inspectImage failed (${res.status}): ${text}`);
		}
		return parseJsonOrThrow(res, 'inspectImage');
	}

	/**
	 * Read a Docker network's config — used to resolve the bridge gateway IP host-side
	 * (`IPAM.Config[].Gateway`, e.g. `172.17.0.1`) for the connectivity preflight,
	 * avoiding a throwaway container just to detect it. Returns null on 404.
	 */
	async inspectNetwork(name: string): Promise<NetworkInfo | null> {
		const res = await this.request('GET', `/networks/${encodeURIComponent(name)}`);
		if (res.status === 404) {
			await res.text();
			return null;
		}
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Docker inspectNetwork failed (${res.status}): ${text}`);
		}
		return parseJsonOrThrow(res, 'inspectNetwork');
	}

	async removeImage(image: string, force = false): Promise<void> {
		const res = await this.request(
			'DELETE',
			`/images/${encodeURIComponent(image)}?force=${force}&noprune=false`,
		);
		if (!res.ok && res.status !== 404) {
			const text = await res.text();
			throw new Error(`Docker removeImage failed (${res.status}): ${text}`);
		}
		await res.text();
	}

	async pullImage(image: string): Promise<void> {
		const res = await this.request('POST', `/images/create?fromImage=${encodeURIComponent(image)}`);
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Docker pullImage failed (${res.status}): ${text}`);
		}
		await res.text();
	}

	async createContainer(
		name: string,
		config: ContainerConfig,
	): Promise<{ Id: string; Warnings: string[] }> {
		const res = await this.request(
			'POST',
			`/containers/create?name=${encodeURIComponent(name)}`,
			config,
			AbortSignal.timeout(DOCKER_CONTROL_TIMEOUT_MS),
		);
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Docker createContainer failed (${res.status}): ${text}`);
		}
		return parseJsonOrThrow(res, 'createContainer');
	}

	async startContainer(containerId: string): Promise<void> {
		const res = await this.request(
			'POST',
			`/containers/${containerId}/start`,
			undefined,
			AbortSignal.timeout(DOCKER_CONTROL_TIMEOUT_MS),
		);
		if (!res.ok && res.status !== 304) {
			const text = await res.text();
			throw new Error(`Docker startContainer failed (${res.status}): ${text}`);
		}
	}

	async stopContainer(containerId: string, timeoutSec = 10): Promise<void> {
		const res = await this.request(
			'POST',
			`/containers/${containerId}/stop?t=${timeoutSec}`,
			undefined,
			AbortSignal.timeout(DOCKER_CONTROL_TIMEOUT_MS),
		);
		if (!res.ok && res.status !== 304) {
			const text = await res.text();
			throw new Error(`Docker stopContainer failed (${res.status}): ${text}`);
		}
	}

	async removeContainer(containerId: string, force = false): Promise<void> {
		const res = await this.request('DELETE', `/containers/${containerId}?force=${force}&v=true`);
		if (!res.ok && res.status !== 404) {
			const text = await res.text();
			throw new Error(`Docker removeContainer failed (${res.status}): ${text}`);
		}
	}

	/**
	 * List containers (running and stopped) carrying the given label key. Used by
	 * `hezo uninstall` to find every container Hezo provisioned — they are all
	 * labelled `hezo.team` (see `provisionContainer`) — so they can be removed
	 * before the data directory is deleted, since the DB rows that otherwise track
	 * their ids go away with it.
	 */
	async listContainersByLabel(label: string): Promise<Array<{ Id: string; Names: string[] }>> {
		const filters = encodeURIComponent(JSON.stringify({ label: [label] }));
		const res = await this.request(
			'GET',
			`/containers/json?all=true&filters=${filters}`,
			undefined,
			AbortSignal.timeout(DOCKER_CONTROL_TIMEOUT_MS),
		);
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Docker listContainers failed (${res.status}): ${text}`);
		}
		return parseJsonOrThrow<Array<{ Id: string; Names: string[] }>>(res, 'listContainers');
	}

	async inspectContainer(containerId: string): Promise<ContainerInfo | null> {
		const res = await this.request(
			'GET',
			`/containers/${containerId}/json`,
			undefined,
			AbortSignal.timeout(DOCKER_REQUEST_TIMEOUT_MS),
		);
		if (res.status === 404) {
			await res.text();
			return null;
		}
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Docker inspectContainer failed (${res.status}): ${text}`);
		}
		return parseJsonOrThrow(res, 'inspectContainer');
	}

	/**
	 * Resolve a container by the deterministic name prefix a project provisions
	 * under. The full name carries a random suffix that is not reconstructable
	 * from project fields, so self-heal matches on the stable
	 * `hezo-<slug>-<id8>` prefix and inspects the live match. Only a container
	 * whose name segment after the prefix is the random suffix counts, so an
	 * unrelated longer-slug project can't be matched by accident.
	 */
	async findContainerByNamePrefix(prefix: string): Promise<ContainerInfo | null> {
		const filters = encodeURIComponent(JSON.stringify({ name: [prefix] }));
		const res = await this.request(
			'GET',
			`/containers/json?all=true&filters=${filters}`,
			undefined,
			AbortSignal.timeout(DOCKER_CONTROL_TIMEOUT_MS),
		);
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Docker listContainers failed (${res.status}): ${text}`);
		}
		const list = await parseJsonOrThrow<Array<{ Id: string; Names: string[] }>>(
			res,
			'listContainers',
		);
		const match = list.find((c) =>
			c.Names.some((n) => n.replace(/^\//, '').startsWith(`${prefix}-`)),
		);
		return match ? this.inspectContainer(match.Id) : null;
	}

	/**
	 * Single-shot memory snapshot via /containers/:id/stats?stream=false.
	 * Returns null when the container is gone or the stats payload is empty
	 * (Docker can return empty bodies for containers that just exited).
	 * `usedBytes` mirrors the `docker stats` CLI computation: raw usage minus
	 * inactive file-backed pages (page cache the kernel can drop on demand),
	 * which avoids flagging containers that are merely reading/writing files.
	 */
	async containerStats(containerId: string): Promise<ContainerMemoryStats | null> {
		// `one-shot=true` returns the daemon's current sample immediately. Without
		// it, `stream=false` still waits for the collector's next tick — roughly a
		// second per call, serialized across every project on every sync pass, on
		// the same socket the live exec streams use. One-shot omits the previous-CPU
		// snapshot, which only matters for CPU percentages; this reads memory.
		const res = await this.request(
			'GET',
			`/containers/${containerId}/stats?stream=false&one-shot=true`,
			undefined,
			AbortSignal.timeout(DOCKER_REQUEST_TIMEOUT_MS),
		);
		if (res.status === 404) {
			await res.text();
			return null;
		}
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Docker containerStats failed (${res.status}): ${text}`);
		}
		const text = await res.text();
		if (text.trim() === '') return null;
		const raw = JSON.parse(text) as RawContainerStats;
		const usage = raw.memory_stats?.usage;
		if (typeof usage !== 'number') return null;
		const inactive =
			raw.memory_stats?.stats?.inactive_file ??
			raw.memory_stats?.stats?.total_inactive_file ??
			raw.memory_stats?.stats?.cache ??
			0;
		const usedBytes = Math.max(0, usage - inactive);
		return { usedBytes, rawUsageBytes: usage };
	}

	async containerLogs(
		containerId: string,
		opts: { follow?: boolean; tail?: number; stdout?: boolean; stderr?: boolean } = {},
		signal?: AbortSignal,
	): Promise<Response | null> {
		const params = new URLSearchParams({
			follow: String(opts.follow ?? true),
			stdout: String(opts.stdout ?? true),
			stderr: String(opts.stderr ?? true),
			tail: String(opts.tail ?? 200),
		});
		const res = await this.requestStream(
			'GET',
			`/containers/${containerId}/logs?${params}`,
			undefined,
			signal,
		);
		if (res.status === 404) {
			await res.text();
			return null;
		}
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Docker containerLogs failed (${res.status}): ${text}`);
		}
		return res;
	}

	async execCreate(containerId: string, config: ExecConfig): Promise<string> {
		const res = await this.request(
			'POST',
			`/containers/${containerId}/exec`,
			config,
			AbortSignal.timeout(DOCKER_CONTROL_TIMEOUT_MS),
		);
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Docker execCreate failed (${res.status}): ${text}`);
		}
		const data = await parseJsonOrThrow<{ Id: string }>(res, 'execCreate');
		return data.Id;
	}

	async execStart(execId: string, opts: ExecStartOpts = {}): Promise<ExecResult> {
		const res = await this.requestStream(
			'POST',
			`/exec/${execId}/start`,
			{ Detach: false, Tty: false },
			opts.signal,
		);
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Docker execStart failed (${res.status}): ${text}`);
		}

		if (!opts.onChunk) {
			const raw = new Uint8Array(await res.arrayBuffer());
			return demuxDockerStream(raw);
		}

		await streamDockerExec(res, opts.onChunk, opts.signal);
		return { stdout: '', stderr: '' };
	}

	async execInspect(execId: string): Promise<{ ExitCode: number; Running: boolean; Pid: number }> {
		const res = await this.request(
			'GET',
			`/exec/${execId}/json`,
			undefined,
			AbortSignal.timeout(DOCKER_CONTROL_TIMEOUT_MS),
		);
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Docker execInspect failed (${res.status}): ${text}`);
		}
		return parseJsonOrThrow(res, 'execInspect');
	}

	/**
	 * Hard-kill every process inside `containerId` whose environment carries
	 * `<name>=<value>` — the scope marker an exec sets and all its children
	 * inherit. Docker exposes no API to signal an exec'd process, and
	 * disconnecting from the exec attach stream (what an abort does) leaves it
	 * running: the process keeps burning tokens / holding sockets / writing to
	 * the workspace even though its exec was abandoned. This is the only way to
	 * actually stop an abandoned exec's process tree.
	 *
	 * The kill exec runs as the container's default user (root — no `User`), so it
	 * can signal the deprivileged run-user's processes, and scans each process's
	 * NUL-separated `/proc/<pid>/environ` for the marker. Bounded by its own short
	 * timeout so a wedged kill can never block run finalization. Best-effort: the
	 * caller swallows failures (a dead/gone container simply can't be exec'd).
	 *
	 * The script itself is runtime-agnostic and shared (`sandbox/proc-scripts.ts`);
	 * only the transport that carries it is Docker's.
	 */
	async killProcessesByEnvMarker(
		containerId: string,
		name: ProcessEnvMarker,
		value: string,
	): Promise<void> {
		const script = buildKillByEnvMarkerScript(name, value);
		const execId = await this.execCreate(containerId, {
			Cmd: ['sh', '-c', script],
			AttachStdout: false,
			AttachStderr: false,
		});
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), KILL_EXEC_TIMEOUT_MS);
		try {
			await this.execStart(execId, { signal: ac.signal });
		} finally {
			clearTimeout(timer);
		}
	}

	/** Kill every process carrying `HEZO_HEARTBEAT_RUN_ID=<runId>` — the marker every agent-run exec sets. */
	async killRunProcesses(containerId: string, runId: string): Promise<void> {
		return this.killProcessesByEnvMarker(containerId, 'HEZO_HEARTBEAT_RUN_ID', runId);
	}

	/**
	 * Scan `/proc` inside `containerId` for Hezo-related processes: anything
	 * carrying a `HEZO_HEARTBEAT_RUN_ID` scope marker, anything whose env carries
	 * an in-container SSH-bridge socket (`SSH_AUTH_SOCK=/run/hezo/…` — legacy git
	 * execs predating the scope marker), and anything whose cmdline names the
	 * bridge binaries or a `/run/hezo/` socket. Only matching pids are emitted,
	 * so output stays tiny even under a high PidsLimit. Runs as root (same
	 * rationale as the kill above) and is bounded by its own timeout. Feeds the
	 * boot-time dangling-process sweep (`process-sweeper.ts`).
	 */
	async listHezoProcesses(containerId: string): Promise<ContainerProcessInfo[]> {
		const script = buildListHezoProcessesScript();
		const execId = await this.execCreate(containerId, {
			Cmd: ['sh', '-c', script],
			AttachStdout: true,
			AttachStderr: false,
		});
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), SWEEP_EXEC_TIMEOUT_MS);
		let stdout: string;
		try {
			({ stdout } = await this.execStart(execId, { signal: ac.signal }));
		} finally {
			clearTimeout(timer);
		}
		return parseHezoProcessList(stdout);
	}

	/**
	 * SIGKILL an explicit pid list inside `containerId`. Companion to
	 * `listHezoProcesses` — the boot sweep decides server-side (it needs the DB)
	 * and kills by pid. Validates every pid so nothing unexpected reaches the
	 * shell; a no-op on an empty list. Best-effort, bounded like the marker kill.
	 */
	async killPids(containerId: string, pids: number[]): Promise<void> {
		if (pids.length === 0) return;
		const script = buildKillPidsScript(pids);
		const execId = await this.execCreate(containerId, {
			Cmd: ['sh', '-c', script],
			AttachStdout: false,
			AttachStderr: false,
		});
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), KILL_EXEC_TIMEOUT_MS);
		try {
			await this.execStart(execId, { signal: ac.signal });
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Bytes used on the filesystem holding `path`, read with `df` inside the
	 * container. Null when the exec failed or answered something unparseable - an
	 * unanswerable measurement must not read as an empty container.
	 */
	async diskUsedBytes(containerId: string, path: string): Promise<number | null> {
		const execId = await this.execCreate(containerId, {
			Cmd: ['sh', '-c', buildDiskUsageScript(path)],
			AttachStdout: true,
			AttachStderr: false,
		});
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), SWEEP_EXEC_TIMEOUT_MS);
		try {
			const { stdout } = await this.execStart(execId, { signal: ac.signal });
			return parseDfKilobytes(stdout);
		} catch {
			return null;
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * {@link SandboxFiles} over Docker's archive endpoints, rooted inside the
	 * container.
	 *
	 * Deliberately **not** the bind mount, even though one is usually there. A
	 * host-filesystem fast path is one that works everywhere except the cases this
	 * seam exists for - a daemon reached over TCP, a rootless daemon in its own
	 * mount namespace, and the managed backend it is a rehearsal for - and it
	 * would be exercised by every local test while the real path shipped
	 * unexercised. Going through the daemon means both backends move the same
	 * bytes the same way and only the transport differs.
	 *
	 * Small metadata questions (exists, find) go through an exec rather than the
	 * archive endpoint: `find` in one call is cheaper and simpler than pulling a
	 * tar of a directory tree just to read its names.
	 */
	files(containerId: string, containerRoot: string): SandboxFiles {
		const abs = (relPath: string): string => resolveContainerPath(containerRoot, relPath);
		const run = async (script: string): Promise<{ exitCode: number; stdout: string }> => {
			const execId = await this.execCreate(containerId, {
				Cmd: ['sh', '-c', script],
				User: 'root',
				AttachStdout: true,
				AttachStderr: true,
			});
			const { stdout } = await this.execStart(execId);
			const { ExitCode } = await this.execInspect(execId);
			return { exitCode: ExitCode, stdout };
		};

		// The byte-level halves of read/write, shared by their UTF-8 and raw
		// variants: only the encode/decode at the very edge differs, and the
		// archive round trip is where every real detail lives.
		const readArchived = async (relPath: string): Promise<Uint8Array> => {
			const res = await this.requestBinary(
				'GET',
				`/containers/${containerId}/archive?path=${encodeURIComponent(abs(relPath))}`,
			);
			if (!res.ok) throw new Error(`sandbox file not found: ${relPath}`);
			const entry = untarFirstFile(new Uint8Array(await res.arrayBuffer()));
			if (!entry) throw new Error(`sandbox file not found: ${relPath}`);
			return entry.contents;
		};

		const writeArchived = async (
			relPath: string,
			contents: Uint8Array,
			opts: { mode?: number; dirMode?: number },
		): Promise<void> => {
			const target = abs(relPath);
			const dir = target.slice(0, Math.max(target.lastIndexOf('/'), 1));
			const dirMode = (opts.dirMode ?? 0o755).toString(8);
			// `mkdir -p` applies the mode only to directories it creates, which
			// matches the host implementation's contract exactly.
			const made = await run(`mkdir -p -m ${dirMode} ${shellQuote(dir)}`);
			if (made.exitCode !== 0) throw new Error(`could not create ${dir} in ${containerId}`);

			const name = target.slice(target.lastIndexOf('/') + 1);
			const archive = tarSingleFile(name, contents, opts.mode ?? 0o644);
			const res = await this.requestBinary(
				'PUT',
				`/containers/${containerId}/archive?path=${encodeURIComponent(dir)}`,
				archive,
			);
			if (!res.ok) {
				throw new Error(`could not write ${relPath} into ${containerId} (${res.status})`);
			}
		};

		return {
			exists: async (relPath) => (await run(`test -e ${shellQuote(abs(relPath))}`)).exitCode === 0,

			read: async (relPath) => new TextDecoder().decode(await readArchived(relPath)),

			readBytes: async (relPath) => readArchived(relPath),

			size: async (relPath) => {
				// `stat -c %s` rather than the archive endpoint's tar header: the
				// point of asking is to avoid transferring the file at all.
				const res = await run(`stat -c %s ${shellQuote(abs(relPath))} 2>/dev/null`);
				if (res.exitCode !== 0) return null;
				const bytes = Number.parseInt(res.stdout.trim(), 10);
				return Number.isFinite(bytes) ? bytes : null;
			},

			remove: async (relPath) => {
				// Best-effort by contract: a missing file is not an error, and the
				// callers that scrub a credential must not fail a run over it.
				await run(`rm -f ${shellQuote(abs(relPath))}`).catch(() => undefined);
			},

			findByName: async (relDir, basename, maxDepth) => {
				const root = abs(relDir);
				// `-type f` and no `-L`: symlinks are never followed, which is what
				// makes the depth cap a real bound rather than an approximate one.
				const res = await run(
					`find ${shellQuote(root)} -maxdepth ${maxDepth + 1} -type f -name ${shellQuote(basename)} 2>/dev/null`,
				);
				if (res.exitCode !== 0) return [];
				return res.stdout
					.split('\n')
					.map((line) => line.trim())
					.filter(Boolean)
					.map((full) =>
						full.startsWith(`${containerRoot}/`) ? full.slice(containerRoot.length + 1) : full,
					);
			},

			write: async (relPath, contents, opts = {}) =>
				writeArchived(relPath, new TextEncoder().encode(contents), opts),

			writeBytes: async (relPath, contents, opts = {}) => writeArchived(relPath, contents, opts),

			removeDir: async (relPath) => {
				// The archive endpoints have no recursive delete, so this is the one
				// file operation that has to be an exec. Best-effort by contract.
				await run(`rm -rf ${shellQuote(abs(relPath))}`).catch(() => undefined);
			},

			list: async (relDir) => {
				// `-A` includes dotfiles and omits `.`/`..`, so an empty listing really
				// means empty.
				const res = await run(`ls -A ${shellQuote(abs(relDir))} 2>/dev/null`);
				if (res.exitCode !== 0) return [];
				return res.stdout
					.split('\n')
					.map((l) => l.trim())
					.filter(Boolean);
			},

			mkdir: async (relPath, opts = {}) => {
				const mode = (opts.mode ?? 0o755).toString(8);
				const res = await run(`mkdir -p -m ${mode} ${shellQuote(abs(relPath))}`);
				if (res.exitCode !== 0) throw new Error(`could not create ${relPath} in ${containerId}`);
			},
		};
	}
}

/**
 * Turn `df -Pk`'s used column into bytes. Null for anything that is not a plain
 * number - a container without `df`, or one whose exec produced nothing, has not
 * reported "empty", it has failed to report.
 */
export function parseDfKilobytes(stdout: string): number | null {
	const kb = Number.parseInt(stdout.trim(), 10);
	return Number.isFinite(kb) && kb >= 0 ? kb * 1024 : null;
}

/**
 * Parse the tab-separated `listHezoProcesses` scan output. The cmdline is the
 * trailing field and may itself contain tabs, so only the first four tabs
 * split; malformed lines (a pid that exited mid-scan can emit partial output)
 * are dropped.
 */
export function parseHezoProcessList(stdout: string): ContainerProcessInfo[] {
	const procs: ContainerProcessInfo[] = [];
	for (const line of stdout.split('\n')) {
		if (line.length === 0) continue;
		const parts = line.split('\t');
		if (parts.length < 5) continue;
		const [pidRaw, runIdRaw, sockRaw, ageRaw] = parts;
		const cmdline = parts.slice(4).join('\t');
		const pid = Number.parseInt(pidRaw, 10);
		const ageSecs = Number.parseInt(ageRaw, 10);
		if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ageSecs)) continue;
		procs.push({
			pid,
			runId: runIdRaw.length > 0 ? runIdRaw : null,
			hasHezoSock: sockRaw === '1',
			ageSecs: Math.max(0, ageSecs),
			cmdline,
		});
	}
	return procs;
}

/**
 * Forward every frame of a live exec attach stream to `onChunk`, retaining
 * nothing. See `ExecStartOpts.onChunk` for why the transcript is not kept.
 */
async function streamDockerExec(
	res: Response,
	onChunk: (c: ExecLogChunk) => void | Promise<void>,
	signal?: AbortSignal,
): Promise<void> {
	const reader = res.body?.getReader();
	if (!reader) return;

	const frames = new DockerFrameDecoder();

	const drainFrames = async () => {
		for (let frame = frames.next(); frame !== null; frame = frames.next()) {
			await onChunk(frame);
		}
	};

	try {
		while (true) {
			if (signal?.aborted) {
				throw new DOMException('Aborted', 'AbortError');
			}
			const { done, value } = await reader.read();
			if (done) break;
			if (value) {
				frames.push(value);
				await drainFrames();
			}
		}
		await drainFrames();
		for (const frame of frames.flush()) await onChunk(frame);
	} finally {
		reader.releaseLock();
	}
}
