import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import { stripNulBytes } from '../lib/sql';

const SOCKET_PATH = '/var/run/docker.sock';
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

interface ContainerConfig {
	Image: string;
	Cmd?: string[];
	Env?: string[];
	WorkingDir?: string;
	Labels?: Record<string, string>;
	HostConfig: {
		Binds?: string[];
		PortBindings?: Record<string, Array<{ HostPort: string }>>;
		ExtraHosts?: string[];
	};
	ExposedPorts?: Record<string, object>;
}

interface ExecConfig {
	Cmd: string[];
	Env?: string[];
	WorkingDir?: string;
	User?: string;
	AttachStdout: boolean;
	AttachStderr: boolean;
}

export interface ExecLogChunk {
	stream: 'stdout' | 'stderr';
	text: string;
}

export interface ExecStartOpts {
	signal?: AbortSignal;
	onChunk?: (chunk: ExecLogChunk) => void | Promise<void>;
}

interface ContainerInfo {
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

export class DockerClient {
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
				req.on('close', () => signal.removeEventListener('abort', onAbort));
			}
			if (payload !== undefined) req.write(payload);
			req.end();
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
		);
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Docker createContainer failed (${res.status}): ${text}`);
		}
		return parseJsonOrThrow(res, 'createContainer');
	}

	async startContainer(containerId: string): Promise<void> {
		const res = await this.request('POST', `/containers/${containerId}/start`);
		if (!res.ok && res.status !== 304) {
			const text = await res.text();
			throw new Error(`Docker startContainer failed (${res.status}): ${text}`);
		}
	}

	async stopContainer(containerId: string, timeoutSec = 10): Promise<void> {
		const res = await this.request('POST', `/containers/${containerId}/stop?t=${timeoutSec}`);
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
		const res = await this.request('GET', `/containers/json?all=true&filters=${filters}`);
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
		const res = await this.request(
			'GET',
			`/containers/${containerId}/stats?stream=false`,
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
		const res = await this.request('POST', `/containers/${containerId}/exec`, config);
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Docker execCreate failed (${res.status}): ${text}`);
		}
		const data = await parseJsonOrThrow<{ Id: string }>(res, 'execCreate');
		return data.Id;
	}

	async execStart(
		execId: string,
		opts: ExecStartOpts = {},
	): Promise<{ stdout: string; stderr: string }> {
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

		return streamDockerExec(res, opts.onChunk, opts.signal);
	}

	async execInspect(execId: string): Promise<{ ExitCode: number; Running: boolean; Pid: number }> {
		const res = await this.request('GET', `/exec/${execId}/json`);
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Docker execInspect failed (${res.status}): ${text}`);
		}
		return parseJsonOrThrow(res, 'execInspect');
	}
}

function demuxDockerStream(raw: Uint8Array): { stdout: string; stderr: string } {
	const stdout: Uint8Array[] = [];
	const stderr: Uint8Array[] = [];
	let offset = 0;

	while (offset + 8 <= raw.length) {
		const streamType = raw[offset];
		const size =
			(raw[offset + 4] << 24) | (raw[offset + 5] << 16) | (raw[offset + 6] << 8) | raw[offset + 7];
		offset += 8;

		if (offset + size > raw.length) break;

		const chunk = raw.slice(offset, offset + size);
		if (streamType === 1) {
			stdout.push(chunk);
		} else if (streamType === 2) {
			stderr.push(chunk);
		}
		offset += size;
	}

	const decoder = new TextDecoder();
	return {
		stdout: stripNulBytes(decoder.decode(concatUint8Arrays(stdout))),
		stderr: stripNulBytes(decoder.decode(concatUint8Arrays(stderr))),
	};
}

async function streamDockerExec(
	res: Response,
	onChunk: (c: ExecLogChunk) => void | Promise<void>,
	signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
	const reader = res.body?.getReader();
	if (!reader) return { stdout: '', stderr: '' };

	const decoder = new TextDecoder();
	const stdoutParts: string[] = [];
	const stderrParts: string[] = [];
	let buffer = new Uint8Array(0);

	const drainFrames = async () => {
		while (buffer.length >= 8) {
			const streamType = buffer[0];
			const size = (buffer[4] << 24) | (buffer[5] << 16) | (buffer[6] << 8) | buffer[7];
			if (buffer.length < 8 + size) break;
			const payload = buffer.slice(8, 8 + size);
			buffer = buffer.slice(8 + size);
			const text = stripNulBytes(decoder.decode(payload));
			const stream: 'stdout' | 'stderr' = streamType === 2 ? 'stderr' : 'stdout';
			if (stream === 'stdout') stdoutParts.push(text);
			else stderrParts.push(text);
			await onChunk({ stream, text });
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
				const next = new Uint8Array(buffer.length + value.length);
				next.set(buffer);
				next.set(value, buffer.length);
				buffer = next;
				await drainFrames();
			}
		}
		await drainFrames();
	} finally {
		reader.releaseLock();
	}

	return { stdout: stdoutParts.join(''), stderr: stderrParts.join('') };
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
	if (arrays.length === 0) return new Uint8Array(0);
	if (arrays.length === 1) return arrays[0];
	const totalLength = arrays.reduce((acc, arr) => acc + arr.length, 0);
	const result = new Uint8Array(totalLength);
	let offset = 0;
	for (const arr of arrays) {
		result.set(arr, offset);
		offset += arr.length;
	}
	return result;
}
