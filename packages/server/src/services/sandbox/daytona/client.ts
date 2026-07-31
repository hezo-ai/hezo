import { logger } from '../../../logger';

const log = logger.child('daytona');

export const DEFAULT_DAYTONA_API_URL = 'https://app.daytona.io/api';

/** Control-plane calls are quick; a wedged one must never stall the run loop. */
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

	/** Write a whole file into the sandbox. */
	async uploadFile(sandbox: DaytonaSandbox, path: string, contents: string): Promise<void> {
		const base = await this.toolboxBase(sandbox);
		const form = new FormData();
		form.append('file', new Blob([contents]), path.split('/').pop() ?? 'file');
		const res = await fetch(`${base}/files/upload?path=${encodeURIComponent(path)}`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${this.apiKey}` },
			body: form,
		});
		if (!res.ok) {
			const text = await res.text();
			throw new DaytonaApiError(
				`Daytona upload ${path} failed (${res.status}): ${text.slice(0, 200)}`,
				res.status,
				text,
			);
		}
	}

	/** Read a whole file out of the sandbox. */
	async downloadFile(sandbox: DaytonaSandbox, path: string): Promise<string> {
		const base = await this.toolboxBase(sandbox);
		const res = await fetch(`${base}/files/download?path=${encodeURIComponent(path)}`, {
			headers: { Authorization: `Bearer ${this.apiKey}` },
		});
		if (!res.ok) {
			const text = await res.text();
			throw new DaytonaApiError(
				`Daytona download ${path} failed (${res.status}): ${text.slice(0, 200)}`,
				res.status,
				text,
			);
		}
		return res.text();
	}
}
