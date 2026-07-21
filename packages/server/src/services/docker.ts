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
 * Every env-marker value interpolated into an in-container `sh -c` script must
 * match this — UUIDs and `<kind>-<hex>` scope ids do; anything shell-active
 * (quotes, spaces, `$`, backticks) is rejected before it reaches the shell.
 */
const ENV_MARKER_VALUE_RE = /^[0-9a-zA-Z_-]{1,64}$/;

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
		CapAdd?: string[];
		CapDrop?: string[];
		/** Run docker-init as PID 1 so zombies are reaped under `sleep infinity`. */
		Init?: boolean;
		/** cgroup hard cap in bytes. */
		Memory?: number;
		/** Equal to Memory so the cap has no swap escape valve. */
		MemorySwap?: number;
		PidsLimit?: number;
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
	 */
	async killProcessesByEnvMarker(
		containerId: string,
		name: 'HEZO_HEARTBEAT_RUN_ID' | 'HEZO_EXEC_SCOPE_ID',
		value: string,
	): Promise<void> {
		// Scope-id values are UUIDs or `<kind>-<hex>` tags. The character-class
		// check guarantees the value needs no shell escaping inside the
		// double-quoted grep pattern below — no metacharacters, word-splitting, or
		// expansion is possible.
		if (!ENV_MARKER_VALUE_RE.test(value)) {
			throw new Error(`unsafe env marker value: ${JSON.stringify(value)}`);
		}
		const marker = `${name}=${value}`;
		// `/proc/<pid>/environ` is NUL-separated; `basename $(dirname …)` recovers the
		// pid without relying on `${…}` shell parameter expansion (a JS-template
		// look-alike). `|| true` keeps a since-exited pid from failing the loop.
		const script =
			'for e in /proc/[0-9]*/environ; do ' +
			`grep -qFz "${marker}" "$e" 2>/dev/null || continue; ` +
			'kill -9 "$(basename "$(dirname "$e")")" 2>/dev/null || true; ' +
			'done';
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
		// Age derives from /proc/uptime minus stat field 22 (starttime, in clock
		// ticks). The stat line's second field (comm) may contain spaces or
		// parentheses, so everything up to the *last* `) ` is stripped first —
		// after that, starttime is field 20 of the remainder.
		const script =
			'up=$(cut -d. -f1 /proc/uptime); hz=$(getconf CLK_TCK 2>/dev/null || echo 100); ' +
			'for d in /proc/[0-9]*; do ' +
			'pid=${d#/proc/}; ' +
			'rid=$(tr "\\0" "\\n" < "$d/environ" 2>/dev/null | sed -n "s/^HEZO_HEARTBEAT_RUN_ID=//p" | head -n1); ' +
			'sock=0; grep -qz "SSH_AUTH_SOCK=/run/hezo/" "$d/environ" 2>/dev/null && sock=1; ' +
			'cmd=$(tr "\\0" " " < "$d/cmdline" 2>/dev/null); ' +
			'st=$(sed "s/^.*) //" "$d/stat" 2>/dev/null | cut -d" " -f20); ' +
			'age=$(( up - ${st:-0} / hz )); ' +
			'case "$cmd" in *hezo-run-with-bridge*|*hezo-ssh-bridge*|*/run/hezo/*) hit=1;; *) hit=0;; esac; ' +
			'if [ -n "$rid" ] || [ "$sock" = 1 ] || [ "$hit" = 1 ]; then ' +
			'printf "%s\\t%s\\t%s\\t%s\\t%s\\n" "$pid" "$rid" "$sock" "$age" "$cmd"; ' +
			'fi; ' +
			'done';
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
		for (const pid of pids) {
			if (!Number.isInteger(pid) || pid <= 1) {
				throw new Error(`unsafe pid: ${JSON.stringify(pid)}`);
			}
		}
		// Validated positive integers only — safe to interpolate. `|| true` keeps
		// an already-exited pid from failing the exec.
		const script = `kill -9 ${pids.join(' ')} 2>/dev/null || true`;
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
