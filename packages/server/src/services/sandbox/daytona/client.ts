import { basename } from 'node:path';
import { logger } from '../../../logger';

const log = logger.child('daytona');

export const DEFAULT_DAYTONA_API_URL = 'https://app.daytona.io/api';

/** Control-plane calls are quick; a wedged one must never stall the run loop. */
/** File transfers are bigger than a control call but must still not hang a run. */
const FILE_TIMEOUT_MS = 120_000;

const CONTROL_TIMEOUT_MS = 60_000;

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
	openPty(sandbox: DaytonaSandbox, sessionId: string): Promise<DaytonaPty>;

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
			// 403 is the one worth naming: Daytona returns a bare "Access denied"
			// for a key missing a scope, which reads like an outage unless you know
			// to look at the key's permissions.
			const hint =
				res.status === 403
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

	listSandboxes(labels?: Record<string, string>): Promise<{ items: DaytonaSandbox[] }> {
		const q = labels ? `?labels=${encodeURIComponent(JSON.stringify(labels))}` : '';
		return this.request<{ items: DaytonaSandbox[] }>('GET', `/sandbox${q}`);
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
	 */
	async executeStreaming(
		sandbox: DaytonaSandbox,
		command: string,
		onLine: (line: string) => void | Promise<void>,
		opts: { cwd?: string; signal?: AbortSignal } = {},
	): Promise<{ exitCode: number }> {
		const base = await this.toolboxBase(sandbox);
		const auth = { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' };
		const sessionId = `hezo-${Math.random().toString(36).slice(2, 10)}`;

		await fetch(`${base}/process/session`, {
			method: 'POST',
			headers: auth,
			body: JSON.stringify({ sessionId }),
			signal: opts.signal,
		});

		const startRes = await fetch(`${base}/process/session/${sessionId}/exec`, {
			method: 'POST',
			headers: auth,
			body: JSON.stringify({
				command: opts.cwd ? `cd ${JSON.stringify(opts.cwd)} && ${command}` : command,
				runAsync: true,
			}),
			signal: opts.signal,
		});
		const started = (await startRes.json()) as { cmdId?: string };
		const cmdId = started.cmdId;
		if (!cmdId) throw new Error('Daytona session exec returned no cmdId');

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
		});
		const info = (await infoRes.json()) as { exitCode?: number | null };
		return { exitCode: info.exitCode ?? 0 };
	}

	/**
	 * Open a PTY session and connect to it.
	 *
	 * Two things about this channel are not obvious and both would corrupt a
	 * framed protocol, so both are handled here rather than left to the caller:
	 * it opens with a `{"status":"connected","type":"control"}` JSON frame that
	 * is **not** shell output and must be swallowed, and it is a PTY, so line
	 * discipline is on until `stty raw -echo` runs. Both were measured against
	 * the live API.
	 */
	async openPty(sandbox: DaytonaSandbox, sessionId: string): Promise<DaytonaPty> {
		const base = await this.toolboxBase(sandbox);
		await fetch(`${base}/process/pty`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ id: sessionId, cols: 200, rows: 50 }),
		});

		const url = `${base.replace(/^http/, 'ws')}/process/pty/${encodeURIComponent(sessionId)}/connect`;
		const socket = new WebSocket(url, {
			headers: { Authorization: `Bearer ${this.apiKey}` },
		} as unknown as string[]);
		socket.binaryType = 'arraybuffer';

		let onData: ((chunk: Uint8Array) => void) | undefined;
		let onClose: (() => void) | undefined;
		let sawControlFrame = false;

		await new Promise<void>((resolve, reject) => {
			socket.onopen = () => resolve();
			socket.onerror = () => reject(new Error('Daytona PTY connect failed'));
		});

		socket.onmessage = (event) => {
			const raw =
				typeof event.data === 'string'
					? new TextEncoder().encode(event.data)
					: new Uint8Array(event.data as ArrayBuffer);
			if (!sawControlFrame) {
				sawControlFrame = true;
				// The opening control frame is JSON, not shell output; feeding it to
				// the frame decoder would desynchronise the stream on byte one.
				const text = new TextDecoder().decode(raw);
				if (text.startsWith('{') && text.includes('"type":"control"')) return;
			}
			onData?.(raw);
		};
		socket.onclose = () => onClose?.();

		// Raw mode before anything framed rides on it: without this the PTY echoes
		// every byte written and rewrites \n as \r\n, which corrupts both
		// directions of a binary protocol.
		socket.send('stty raw -echo\n');

		return {
			send: (data) => socket.send(data),
			onData: (handler) => {
				onData = handler;
			},
			onClose: (handler) => {
				onClose = handler;
			},
			close: () => socket.close(),
		};
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
