import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { trackBackground } from '../../../lib/background';
import { logger } from '../../../logger';

const log = logger.child('daytona');

export const DEFAULT_DAYTONA_API_URL = 'https://app.daytona.io/api';

/** Control-plane calls are quick; a wedged one must never stall the run loop. */
/** File transfers are bigger than a control call but must still not hang a run. */
const FILE_TIMEOUT_MS = 120_000;

const CONTROL_TIMEOUT_MS = 60_000;

/**
 * How long the PTY has to reach raw mode and echo its sentinel.
 *
 * Generous, because it covers a shell starting inside a sandbox that may still
 * be settling - but bounded, because the alternative to failing here is a
 * channel that silently never carries a frame.
 */
const PTY_SYNC_TIMEOUT_MS = 30_000;

/**
 * How long the PTY WebSocket has to finish its handshake.
 *
 * A `WebSocket` whose TCP connection is accepted but whose upgrade never
 * completes fires **neither** `open` nor `error`, so the promise that awaits one
 * of them never settles - and the caller is a run acquiring its tunnel, which
 * then waits forever with nothing to report. `PTY_SYNC_TIMEOUT_MS` covers only
 * what happens *after* the socket opens, so it cannot bound this.
 */
const PTY_CONNECT_TIMEOUT_MS = 30_000;

/**
 * Pages `listSandboxes` will follow before giving up.
 *
 * A backstop against a server that never stops handing back a cursor, not a
 * limit on how many sandboxes an account may have - at any plausible page size
 * this is far more than the instance memory budget could ever run. Hitting it is
 * logged, because a sweep that silently covered part of the fleet reads exactly
 * like one that covered all of it.
 */
const MAX_SANDBOX_PAGES = 100;

/**
 * Sandbox lifecycle states Daytona reports. Only the ones Hezo reacts to are
 * named; anything else is treated as not-running.
 */
export type DaytonaState =
	| 'creating'
	| 'restoring'
	| 'destroyed'
	| 'destroying'
	| 'started'
	| 'stopped'
	| 'starting'
	| 'stopping'
	| 'error'
	| 'build_failed'
	| 'pending_build'
	| 'building_snapshot'
	| 'unknown'
	| 'pulling_snapshot'
	| 'archived'
	| 'archiving'
	| 'resizing'
	| 'snapshotting'
	| 'forking'
	| 'pausing'
	| 'paused'
	| 'resuming'
	// Open rather than closed: an unrecognized state must degrade to
	// "not running" rather than fail to parse.
	| (string & {});

export interface DaytonaSandbox {
	id: string;
	name?: string;
	state: DaytonaState;
	labels?: Record<string, string>;
	errorReason?: string | null;
	toolboxProxyUrl?: string;
	cpu?: number;
	memory?: number;
	disk?: number;
}

export interface DaytonaVolume {
	id: string;
	name: string;
	state: string;
	errorReason?: string | null;
}

export interface CreateSandboxSpec {
	/** Dockerfile content; one line (`FROM …@sha256:…`) is the normal case. */
	dockerfileContent: string;
	labels?: Record<string, string>;
	env?: Record<string, string>;
	volumes?: Array<{ volumeId: string; mountPath: string; subpath?: string }>;
	cpu?: number;
	memory?: number;
	disk?: number;
	/** Minutes of inactivity before Daytona stops it; 0 disables. */
	autoStopInterval?: number;
	/**
	 * Minutes after stopping before Daytona deletes it; **negative disables**.
	 * A stopped sandbox has to survive so it can be resumed with its filesystem
	 * intact, so Hezo always disables this rather than leaving the default.
	 */
	autoDeleteInterval?: number;
}

export class DaytonaApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly body: string,
	) {
		super(message);
		this.name = 'DaytonaApiError';
	}
}

/**
 * The slice of Daytona's API the engine actually drives.
 *
 * The engine depends on this rather than on `DaytonaClient` so a test can supply
 * a complete implementation instead of a partial object cast through `unknown` -
 * the failure mode AGENTS.md calls out, where a stub silently omits a method
 * until production calls it.
 */
export interface DaytonaApi {
	ping(): Promise<boolean>;
	createSandbox(spec: CreateSandboxSpec): Promise<DaytonaSandbox>;
	getSandbox(id: string): Promise<DaytonaSandbox | null>;
	listSandboxes(labels?: Record<string, string>): Promise<{ items: DaytonaSandbox[] }>;
	start(id: string): Promise<void>;
	stop(id: string): Promise<void>;
	destroy(id: string): Promise<void>;
	getMetrics(id: string, windowMs: number): Promise<Map<string, number>>;
	execute(
		sandbox: DaytonaSandbox,
		command: string,
		opts?: { cwd?: string; timeoutMs?: number; signal?: AbortSignal },
	): Promise<{ exitCode: number; output: string }>;
	executeStreaming(
		sandbox: DaytonaSandbox,
		command: string,
		onLine: (line: string) => void | Promise<void>,
		opts?: { cwd?: string; signal?: AbortSignal },
	): Promise<{ exitCode: number }>;
	openPty(sandbox: DaytonaSandbox, sessionId: string, launch: string): Promise<DaytonaPty>;

	// ---- files -------------------------------------------------------------
	// Measured against the live toolbox API; see DaytonaClient for the shapes and
	// the status codes each one actually answers with.
	listFiles(sandbox: DaytonaSandbox, path: string): Promise<DaytonaFileEntry[]>;
	downloadFile(sandbox: DaytonaSandbox, path: string): Promise<Uint8Array | null>;
	/** Metadata for one path, or null when it is not there. Answers for a directory too. */
	statFile(sandbox: DaytonaSandbox, path: string): Promise<DaytonaFileEntry | null>;
	uploadFile(
		sandbox: DaytonaSandbox,
		path: string,
		content: Uint8Array,
		mode?: number,
	): Promise<void>;
	createFolder(sandbox: DaytonaSandbox, path: string, mode?: number): Promise<void>;
	/**
	 * Delete a path. `recursive` is required for a non-empty directory - without
	 * it the API refuses with a 400 rather than deleting what it can.
	 */
	deleteFile(sandbox: DaytonaSandbox, path: string, opts?: { recursive?: boolean }): Promise<void>;
}

/** One entry from the toolbox directory listing. */
export interface DaytonaFileEntry {
	name: string;
	path: string;
	size: number;
	isDir: boolean;
	/** Octal string, e.g. `0644`. */
	permissions?: string;
}

/**
 * A raw bidirectional byte channel into a sandbox.
 *
 * Daytona's exec has no stdin at all - `input`/`stdin`/`stdinData` are ignored
 * and a command reading stdin sees immediate EOF, measured against the live
 * API. Its **PTY over WebSocket** is the only bidirectional channel it offers,
 * which is why the tunnel's transport is per-backend even though its framing is
 * not.
 */
export interface DaytonaPty {
	send(data: Uint8Array): void;
	onData(handler: (chunk: Uint8Array) => void): void;
	onClose(handler: () => void): void;
	close(): void;
}

/**
 * Thin REST client for Daytona's control plane and per-sandbox toolbox.
 *
 * Two different hosts are involved and conflating them is the easy mistake: the
 * control plane (create/start/stop/delete) lives at the API base, while exec and
 * file operations go to a per-sandbox **toolbox proxy** whose URL the sandbox
 * record carries. The proxy path has no `/toolbox` segment after the sandbox id
 * even though the base ends in one.
 *
 * Deliberately not the official SDK: the surface Hezo needs is small, and a
 * hand-rolled client keeps the dependency out of the single-binary build and
 * makes the error shapes ours to map.
 */
export class DaytonaClient implements DaytonaApi {
	constructor(
		private readonly apiKey: string,
		private readonly apiUrl: string = DEFAULT_DAYTONA_API_URL,
	) {}

	private async request<T>(
		method: string,
		path: string,
		body?: unknown,
		opts: { timeoutMs?: number; base?: string } = {},
	): Promise<T> {
		const base = opts.base ?? this.apiUrl;
		const res = await fetch(`${base}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${this.apiKey}`,
				...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(opts.timeoutMs ?? CONTROL_TIMEOUT_MS),
		});
		const text = await res.text();
		if (!res.ok) {
			// 403 is worth naming, because Daytona returns a bare "Access denied" for
			// a key missing a scope and that reads like an outage unless you know to
			// look at the key's permissions.
			//
			// Only where a scope is actually the likely cause, though. The telemetry
			// endpoint 403s on an ordinary account for a reason it states itself
			// ("Telemetry endpoints are disabled when Analytics API is configured"),
			// and appending a scope hint there sent the reader to change permissions
			// that have nothing to do with it - a confident wrong diagnosis is worse
			// than none, since the response body already said what was wrong.
			const hint =
				res.status === 403 && !path.includes('/telemetry/')
					? ' (the API key is likely missing a permission scope - volumes need read:volumes/write:volumes/delete:volumes)'
					: '';
			throw new DaytonaApiError(
				`Daytona ${method} ${path} failed (${res.status})${hint}: ${text.slice(0, 400)}`,
				res.status,
				text,
			);
		}
		if (text.trim() === '') return undefined as T;
		try {
			return JSON.parse(text) as T;
		} catch {
			return text as unknown as T;
		}
	}

	// ---- control plane -----------------------------------------------------

	async ping(): Promise<boolean> {
		try {
			await this.request('GET', '/sandbox', undefined, { timeoutMs: 10_000 });
			return true;
		} catch (e) {
			log.warn(`Daytona ping failed: ${(e as Error).message}`);
			return false;
		}
	}

	createSandbox(spec: CreateSandboxSpec): Promise<DaytonaSandbox> {
		return this.request<DaytonaSandbox>('POST', '/sandbox', {
			buildInfo: { dockerfileContent: spec.dockerfileContent },
			...(spec.labels ? { labels: spec.labels } : {}),
			...(spec.env ? { env: spec.env } : {}),
			...(spec.volumes ? { volumes: spec.volumes } : {}),
			...(spec.cpu ? { cpu: spec.cpu } : {}),
			...(spec.memory ? { memory: spec.memory } : {}),
			...(spec.disk ? { disk: spec.disk } : {}),
			...(spec.autoStopInterval === undefined ? {} : { autoStopInterval: spec.autoStopInterval }),
			...(spec.autoDeleteInterval === undefined
				? {}
				: { autoDeleteInterval: spec.autoDeleteInterval }),
		});
	}

	async getSandbox(id: string): Promise<DaytonaSandbox | null> {
		try {
			return await this.request<DaytonaSandbox>('GET', `/sandbox/${encodeURIComponent(id)}`);
		} catch (e) {
			if (e instanceof DaytonaApiError && e.status === 404) return null;
			throw e;
		}
	}

	/**
	 * Every sandbox matching the labels, following the cursor to the end.
	 *
	 * `GET /sandbox` is paginated - it answers `{items, nextCursor}` and takes a
	 * `cursor` query parameter (measured against the live API: a bad value returns
	 * a specific 400, "Invalid cursor provided"). Reading only the first page is
	 * how this went wrong quietly: the orphan reaper would sweep a page and report
	 * success while every sandbox past it kept billing, and
	 * `findContainerByNamePrefix` would answer "no such container" for a container
	 * that exists - reprovisioning a second one beside it.
	 *
	 * Bounded, and loudly. A server that keeps handing back a cursor would
	 * otherwise spin here forever, and a truncated sweep that says nothing reads
	 * exactly like a complete one.
	 */
	async listSandboxes(labels?: Record<string, string>): Promise<{ items: DaytonaSandbox[] }> {
		const labelQuery = labels ? `labels=${encodeURIComponent(JSON.stringify(labels))}` : '';
		const items: DaytonaSandbox[] = [];
		let cursor: string | null = null;
		for (let page = 0; page < MAX_SANDBOX_PAGES; page++) {
			const params = [labelQuery, cursor ? `cursor=${encodeURIComponent(cursor)}` : '']
				.filter(Boolean)
				.join('&');
			const res: { items?: DaytonaSandbox[]; nextCursor?: string | null } = await this.request<{
				items?: DaytonaSandbox[];
				nextCursor?: string | null;
			}>('GET', `/sandbox${params ? `?${params}` : ''}`);
			items.push(...(res.items ?? []));
			cursor = res.nextCursor ?? null;
			if (!cursor) return { items };
		}
		log.warn(
			`listSandboxes stopped at ${MAX_SANDBOX_PAGES} pages (${items.length} sandboxes) with a cursor still pending; ` +
				'anything past this point is not swept and will keep billing',
		);
		return { items };
	}

	start(id: string): Promise<void> {
		return this.request('POST', `/sandbox/${encodeURIComponent(id)}/start`);
	}

	stop(id: string): Promise<void> {
		return this.request('POST', `/sandbox/${encodeURIComponent(id)}/stop`);
	}

	async destroy(id: string): Promise<void> {
		try {
			await this.request('DELETE', `/sandbox/${encodeURIComponent(id)}?force=true`);
		} catch (e) {
			// Already gone is success. A sandbox mid-build answers 409; the caller
			// (the orphan reaper) retries, so surfacing it is correct.
			if (e instanceof DaytonaApiError && e.status === 404) return;
			throw e;
		}
	}

	/**
	 * Latest value of each OTEL metric series in a trailing window.
	 *
	 * This is the one call that answers the parity question the plan left open -
	 * whether per-sandbox memory stats exist at all. They do, but as an
	 * observability query over a time range rather than a live gauge, so the
	 * caller takes the most recent data point and tolerates an empty series.
	 */
	async getMetrics(id: string, windowMs: number): Promise<Map<string, number>> {
		const to = new Date();
		const from = new Date(to.getTime() - windowMs);
		const q = `?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
		const res = await this.request<{
			series?: Array<{
				metricName: string;
				dataPoints?: Array<{ timestamp: string; value: number }>;
			}>;
		}>('GET', `/sandbox/${encodeURIComponent(id)}/telemetry/metrics${q}`, undefined, {
			timeoutMs: 15_000,
		});
		const out = new Map<string, number>();
		for (const s of res.series ?? []) {
			const last = s.dataPoints?.at(-1);
			if (last) out.set(s.metricName, last.value);
		}
		return out;
	}

	// ---- volumes -----------------------------------------------------------

	async ensureVolume(name: string): Promise<DaytonaVolume> {
		const existing = await this.request<{ items?: DaytonaVolume[] } | DaytonaVolume[]>(
			'GET',
			'/volumes',
		);
		const items = Array.isArray(existing) ? existing : (existing.items ?? []);
		const found = items.find((v) => v.name === name && v.state !== 'pending_delete');
		if (found) return found;
		return this.request<DaytonaVolume>('POST', '/volumes', { name });
	}

	// ---- toolbox (per-sandbox) ---------------------------------------------

	/**
	 * Resolve the exec/file base for a sandbox.
	 *
	 * The sandbox record's `toolboxProxyUrl` already ends in `/toolbox`, and the
	 * per-sandbox path is appended directly - `…/toolbox/<id>/process/execute`.
	 * An extra `/toolbox` segment 404s, which is easy to hit by pattern-matching
	 * on the control-plane paths.
	 */
	private async toolboxBase(sandbox: DaytonaSandbox): Promise<string> {
		const proxy =
			sandbox.toolboxProxyUrl ??
			(await this.getSandbox(sandbox.id))?.toolboxProxyUrl ??
			'https://proxy.app.daytona.io/toolbox';
		return `${proxy}/${sandbox.id}`;
	}

	/** Run a command to completion and return its exit code and combined output. */
	async execute(
		sandbox: DaytonaSandbox,
		command: string,
		opts: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<{ exitCode: number; output: string }> {
		const base = await this.toolboxBase(sandbox);
		const res = await fetch(`${base}/process/execute`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ command, ...(opts.cwd ? { cwd: opts.cwd } : {}) }),
			signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? CONTROL_TIMEOUT_MS),
		});
		const text = await res.text();
		if (!res.ok) {
			throw new DaytonaApiError(
				`Daytona execute failed (${res.status}): ${text.slice(0, 400)}`,
				res.status,
				text,
			);
		}
		const data = JSON.parse(text) as { exitCode?: number; result?: string };
		return { exitCode: data.exitCode ?? 0, output: data.result ?? '' };
	}

	/**
	 * Run a command and stream its output line by line, resolving with the exit
	 * code once it finishes.
	 *
	 * Daytona has no single streaming-exec call: a session is created, the command
	 * is started async, and its logs are followed on a second request. That split
	 * is why the engine cannot simply map `execStart` onto one HTTP call.
	 *
	 * The session is **always deleted**, on every path out. A session is a shell
	 * that outlives the command it ran, and this is the streaming exec - the one
	 * every agent run, every git operation and every chat turn goes through. One
	 * abandoned session per exec on a container the pool keeps for hours is how a
	 * sandbox ends up wedged against its process limit, with the run that finally
	 * hits it reported as an agent failure.
	 */
	async executeStreaming(
		sandbox: DaytonaSandbox,
		command: string,
		onLine: (line: string) => void | Promise<void>,
		opts: { cwd?: string; signal?: AbortSignal } = {},
	): Promise<{ exitCode: number }> {
		const base = await this.toolboxBase(sandbox);
		const auth = { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' };
		const sessionId = `hezo-${randomBytes(6).toString('hex')}`;

		const created = await fetch(`${base}/process/session`, {
			method: 'POST',
			headers: auth,
			body: JSON.stringify({ sessionId }),
			signal: opts.signal ?? AbortSignal.timeout(CONTROL_TIMEOUT_MS),
		});
		if (!created.ok) {
			// Reported rather than swallowed: every later call in this method is
			// addressed to a session that does not exist, so the real failure would
			// otherwise surface as a confusing "returned no cmdId" one step later.
			const body = await created.text();
			throw new DaytonaApiError(
				`Daytona session create failed (${created.status}): ${body.slice(0, 400)}`,
				created.status,
				body,
			);
		}

		try {
			const startRes = await fetch(`${base}/process/session/${sessionId}/exec`, {
				method: 'POST',
				headers: auth,
				body: JSON.stringify({
					command: opts.cwd ? `cd ${JSON.stringify(opts.cwd)} && ${command}` : command,
					runAsync: true,
				}),
				signal: opts.signal ?? AbortSignal.timeout(CONTROL_TIMEOUT_MS),
			});
			const started = (await startRes.json()) as { cmdId?: string };
			const cmdId = started.cmdId;
			if (!cmdId) throw new Error('Daytona session exec returned no cmdId');

			// Deliberately no timeout on the follow stream: it stays open for the
			// whole command, and an agent run legitimately runs for its full timeout.
			// `opts.signal` is how a caller ends it early.
			const logsRes = await fetch(
				`${base}/process/session/${sessionId}/command/${cmdId}/logs?follow=true`,
				{ headers: { Authorization: `Bearer ${this.apiKey}` }, signal: opts.signal },
			);
			if (logsRes.body) {
				const reader = logsRes.body.getReader();
				const decoder = new TextDecoder();
				let buf = '';
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					buf += decoder.decode(value, { stream: true });
					const lines = buf.split('\n');
					buf = lines.pop() ?? '';
					for (const line of lines) await onLine(`${line}\n`);
				}
				if (buf) await onLine(buf);
			}

			// The follow stream ends when the command does; the exit code is only on
			// the command record, so it is fetched rather than parsed out of the logs.
			const infoRes = await fetch(`${base}/process/session/${sessionId}/command/${cmdId}`, {
				headers: { Authorization: `Bearer ${this.apiKey}` },
				signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
			});
			const info = (await infoRes.json()) as { exitCode?: number | null };
			return { exitCode: info.exitCode ?? 0 };
		} finally {
			// Awaited, not backgrounded: the caller is about to release the container
			// back to the pool, and the next run's exec must not find the sandbox
			// carrying this one's shell.
			await this.deleteSession(sandbox, sessionId).catch((e) => {
				log.warn(`could not delete exec session ${sessionId}: ${(e as Error).message}`);
			});
		}
	}

	/** End a command session, terminating the shell it holds. */
	private async deleteSession(sandbox: DaytonaSandbox, sessionId: string): Promise<void> {
		const base = await this.toolboxBase(sandbox);
		const res = await fetch(`${base}/process/session/${encodeURIComponent(sessionId)}`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${this.apiKey}` },
			signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
		});
		// A session that is already gone is the desired end state, not an error.
		if (!res.ok && res.status !== 404) {
			const body = await res.text();
			throw new DaytonaApiError(`Daytona session delete failed (${res.status})`, res.status, body);
		}
	}

	/**
	 * Open a PTY session, launch a command on it, and hand back a byte channel
	 * carrying only that command's own output.
	 *
	 * Everything before the command's first byte is shell noise, and a framed
	 * protocol riding this channel is desynchronised by any of it - the decoder
	 * reads whatever arrives first as `[u8 type][u32 streamId][u32 len]`. Four
	 * distinct sources of noise were measured on the live API, and the launch is
	 * folded into this method precisely so none of them can reach the caller:
	 *
	 * 1. The channel opens with a `{"status":"connected","type":"control"}` JSON
	 *    frame, which is not shell output.
	 * 2. It is a PTY with echo on, so `stty raw -echo` is itself echoed back
	 *    before it takes effect. That echo alone is fatal: the decoder reads
	 *    `stty` as a type and stream id and `raw ` as a 1918990112-byte length.
	 * 3. The interactive shell prints a prompt, and brackets each command it
	 *    accepts with bracketed-paste sequences (`ESC[?2004h` / `ESC[?2004l`) -
	 *    emitted even with echo off, so raw mode does not suppress them.
	 * 4. A shell that outlived the command would print a further prompt.
	 *
	 * So one line is sent - set raw mode, print a per-session sentinel, then
	 * **`exec`** the command - and every byte up to and including that sentinel is
	 * discarded. `exec` replaces the shell, which removes (3) and (4) for good
	 * rather than filtering them; the sentinel is printed after `stty` has been
	 * applied, so it lands past (2); it is random per session, so it cannot
	 * collide with the command's own output; and it is emitted from two halves so
	 * that the echoed command line does not contain it (see the send below).
	 */
	async openPty(sandbox: DaytonaSandbox, sessionId: string, launch: string): Promise<DaytonaPty> {
		const base = await this.toolboxBase(sandbox);
		await fetch(`${base}/process/pty`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ id: sessionId, cols: 200, rows: 50 }),
			signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
		});

		const url = `${base.replace(/^http/, 'ws')}/process/pty/${encodeURIComponent(sessionId)}/connect`;
		const socket = new WebSocket(url, {
			headers: { Authorization: `Bearer ${this.apiKey}` },
		} as unknown as string[]);
		socket.binaryType = 'arraybuffer';

		let onData: ((chunk: Uint8Array) => void) | undefined;
		let onClose: (() => void) | undefined;
		let closed = false;

		// Bounded: a half-open upgrade fires neither handler, and the unbounded
		// version of this await hung the run that was acquiring its tunnel.
		const connected = Promise.withResolvers<void>();
		const connectTimer = setTimeout(() => {
			connected.reject(new Error(`Daytona PTY did not connect within ${PTY_CONNECT_TIMEOUT_MS}ms`));
		}, PTY_CONNECT_TIMEOUT_MS);
		socket.onopen = () => connected.resolve();
		socket.onerror = () => connected.reject(new Error('Daytona PTY connect failed'));
		try {
			await connected.promise;
		} catch (e) {
			// The session outlives a failed connect - it is created by the POST above,
			// not by the socket - so it has to be deleted or it sits there holding a
			// shell for the sandbox's life.
			socket.close();
			await this.deletePtySession(sandbox, sessionId).catch(() => undefined);
			throw e;
		} finally {
			clearTimeout(connectTimer);
		}

		const sentinel = `__hezo_pty_${randomBytes(8).toString('hex')}__`;
		const sentinelBytes = new TextEncoder().encode(sentinel);
		let synced = false;
		let preamble = new Uint8Array(0);
		const ready = Promise.withResolvers<void>();

		socket.onmessage = (event) => {
			const raw =
				typeof event.data === 'string'
					? new TextEncoder().encode(event.data)
					: new Uint8Array(event.data as ArrayBuffer);
			if (synced) {
				onData?.(raw);
				return;
			}
			// Held rather than forwarded: the sentinel can be split across frames,
			// so the search runs over the accumulation, not over one chunk.
			preamble = concatBytes(preamble, raw);
			const at = lastIndexOfBytes(preamble, sentinelBytes);
			if (at === -1) return;
			synced = true;
			const rest = preamble.subarray(at + sentinelBytes.length);
			preamble = new Uint8Array(0);
			ready.resolve();
			// Bytes past the sentinel are already the command's - a command that
			// writes immediately would otherwise lose its first frame.
			if (rest.length > 0) onData?.(rest);
		};
		socket.onclose = () => {
			closed = true;
			ready.reject(new Error('Daytona PTY closed before the launch completed'));
			onClose?.();
		};

		// The sentinel is emitted from two halves. While echo is still on the
		// command line itself comes back, and a line carrying the sentinel
		// *literally* would be matched by the search - syncing on the echo and
		// forwarding the real one, which is the same corruption one step later
		// (measured: the decoder then read the sentinel's own bytes as a header).
		// Split across two arguments, the echoed line contains `'…_pty_' 'abc__'`
		// and the contiguous sentinel appears exactly once, in the output.
		const half = Math.ceil(sentinel.length / 2);
		socket.send(
			`stty raw -echo; printf '%s%s' ${shellQuoteSingle(sentinel.slice(0, half))} ` +
				`${shellQuoteSingle(sentinel.slice(half))}; exec ${launch}\n`,
		);

		const timer = setTimeout(() => {
			ready.reject(new Error(`Daytona PTY did not reach raw mode within ${PTY_SYNC_TIMEOUT_MS}ms`));
		}, PTY_SYNC_TIMEOUT_MS);
		try {
			await ready.promise;
		} catch (e) {
			// Same reasoning as the connect path: closing the socket leaves the
			// session, and its shell, running (measured - see `close` below).
			if (!closed) socket.close();
			await this.deletePtySession(sandbox, sessionId).catch(() => undefined);
			throw e;
		} finally {
			clearTimeout(timer);
		}

		return {
			send: (data) => socket.send(data),
			onData: (handler) => {
				onData = handler;
			},
			onClose: (handler) => {
				onClose = handler;
			},
			close: () => {
				socket.close();
				// Closing the socket does **not** end the session or kill what runs
				// on it - measured: a process launched on a PTY was still listening
				// after the WebSocket closed, and the session still read `active`.
				// Only deleting the session terminates it.
				//
				// On Docker the equivalent close kills the exec, so a caller that
				// only closed the socket would leak a process per channel on this
				// backend alone. For the tunnel that leak is not cosmetic: the client
				// holds the run's three loopback ports, and because a pooled
				// container serves many runs in sequence, the *next* run's client
				// dies with `EADDRINUSE` and the whole run loses MCP and egress.
				trackBackground(
					this.deletePtySession(sandbox, sessionId).catch((e) => {
						log.warn(`could not delete PTY session ${sessionId}: ${(e as Error).message}`);
					}),
				);
			},
		};
	}

	/** End a PTY session, terminating whatever is running on it. */
	private async deletePtySession(sandbox: DaytonaSandbox, sessionId: string): Promise<void> {
		const base = await this.toolboxBase(sandbox);
		const res = await fetch(`${base}/process/pty/${encodeURIComponent(sessionId)}`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${this.apiKey}` },
			signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
		});
		// A session that is already gone is the desired end state, not an error.
		if (!res.ok && res.status !== 404) {
			throw new DaytonaApiError(
				`Daytona DELETE /process/pty/${sessionId} failed (${res.status})`,
				res.status,
				await res.text(),
			);
		}
	}

	// ---- files -------------------------------------------------------------
	//
	// All five paths were measured against the live API rather than read off the
	// spec, and two of the results are not what the obvious reading gives:
	// `files/folder` answers **201** (not 200), and `files/find` matches file
	// *content*, not names - a `pattern` of `x.txt` against an existing
	// `/workspace/probe/x.txt` returns `[]`. `SandboxFiles.findByName` is
	// therefore built on the directory listing, exactly like the host
	// implementation, rather than on an endpoint that looks right and silently
	// finds nothing.

	private async fileRequest(
		sandbox: DaytonaSandbox,
		method: string,
		path: string,
		init: { body?: BodyInit; accept?: 'json' | 'bytes' | 'none' } = {},
	): Promise<Response> {
		const base = await this.toolboxBase(sandbox);
		const res = await fetch(`${base}${path}`, {
			method,
			headers: { Authorization: `Bearer ${this.apiKey}` },
			body: init.body,
			signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
		});
		if (!res.ok && res.status !== 404) {
			const text = await res.text();
			throw new DaytonaApiError(
				`Daytona file ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`,
				res.status,
				text,
			);
		}
		return res;
	}

	async listFiles(sandbox: DaytonaSandbox, path: string): Promise<DaytonaFileEntry[]> {
		const res = await this.fileRequest(sandbox, 'GET', `/files?path=${encodeURIComponent(path)}`);
		if (!res.ok) return [];
		const body = (await res.json()) as DaytonaFileEntry[] | null;
		return Array.isArray(body) ? body : [];
	}

	async downloadFile(sandbox: DaytonaSandbox, path: string): Promise<Uint8Array | null> {
		const res = await this.fileRequest(
			sandbox,
			'GET',
			`/files/download?path=${encodeURIComponent(path)}`,
		);
		// A missing file is not an error here - `SandboxFiles.exists` is built on
		// it, and every read-back call site treats absence as "nothing to recover".
		if (!res.ok) return null;
		return new Uint8Array(await res.arrayBuffer());
	}

	async uploadFile(
		sandbox: DaytonaSandbox,
		path: string,
		content: Uint8Array,
		mode?: number,
	): Promise<void> {
		const form = new FormData();
		// The field name is `file`; the filename is ignored in favour of `?path=`.
		form.append('file', new Blob([content as BlobPart]), basename(path));
		await this.fileRequest(sandbox, 'POST', `/files/upload?path=${encodeURIComponent(path)}`, {
			body: form,
		});
		// Uploads land 0644 owned by root regardless of the caller, so a mode that
		// matters - a credential file the agent must not read, a config it must -
		// is applied as a second call rather than assumed.
		if (mode !== undefined) await this.setPermissions(sandbox, path, mode);
	}

	async createFolder(sandbox: DaytonaSandbox, path: string, mode = 0o755): Promise<void> {
		const res = await this.fileRequest(
			sandbox,
			'POST',
			`/files/folder?path=${encodeURIComponent(path)}&mode=${mode.toString(8)}`,
		);
		// 201 on create; a directory that already exists answers 404 rather than a
		// conflict, which is why a missing-parent failure has to surface from the
		// upload rather than from here.
		void res;
	}

	/**
	 * Metadata for one path. Unlike `files/download` this answers for a directory
	 * as well as a file, which is what makes it the right primitive for an
	 * existence check - downloading a directory is a 400, not a "no".
	 */
	async statFile(sandbox: DaytonaSandbox, path: string): Promise<DaytonaFileEntry | null> {
		const res = await this.fileRequest(
			sandbox,
			'GET',
			`/files/info?path=${encodeURIComponent(path)}`,
		);
		if (!res.ok) return null;
		return (await res.json()) as DaytonaFileEntry;
	}

	async deleteFile(
		sandbox: DaytonaSandbox,
		path: string,
		opts: { recursive?: boolean } = {},
	): Promise<void> {
		// A non-empty directory is refused outright without this - "cannot delete
		// directory without recursive flag", measured - so a scrub that omitted it
		// left the whole tree in place while looking like it had worked.
		const recursive = opts.recursive ? '&recursive=true' : '';
		await this.fileRequest(
			sandbox,
			'DELETE',
			`/files?path=${encodeURIComponent(path)}${recursive}`,
		);
	}

	private async setPermissions(sandbox: DaytonaSandbox, path: string, mode: number): Promise<void> {
		await this.fileRequest(
			sandbox,
			'POST',
			`/files/permissions?path=${encodeURIComponent(path)}&mode=${mode.toString(8).padStart(3, '0')}`,
		);
	}
}

/**
 * Single-quote a value for the shell. Local to the client because the PTY
 * launch line is assembled here; `command.ts` owns the exec rendering and has
 * its own copy of the same rule for the same reason.
 */
function shellQuoteSingle(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}

/**
 * Index of the last occurrence of `needle` in `haystack`, or -1.
 *
 * Searched from the end so that if the sentinel ever did appear twice, the sync
 * lands on the later one - forwarding from an earlier match would leave the
 * second copy in the stream, which is exactly the corruption being prevented.
 */
function lastIndexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
	if (needle.length === 0 || haystack.length < needle.length) return -1;
	outer: for (let start = haystack.length - needle.length; start >= 0; start--) {
		for (let i = 0; i < needle.length; i++) {
			if (haystack[start + i] !== needle[i]) continue outer;
		}
		return start;
	}
	return -1;
}
