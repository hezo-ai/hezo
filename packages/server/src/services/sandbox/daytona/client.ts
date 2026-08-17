import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { trackBackground } from '../../../lib/background';
import { combineAbortSignals } from '../../../lib/net';
import { logger } from '../../../logger';
import { ContainerUnreachableError, ExecStreamLostError } from '../errors';
import { chunkPtyPayload } from './command';

const log = logger.child('daytona');

export const DEFAULT_DAYTONA_API_URL = 'https://app.daytona.io/api';

/** Control-plane calls are quick; a wedged one must never stall the run loop. */
/** File transfers are bigger than a control call but must still not hang a run. */
const FILE_TIMEOUT_MS = 120_000;

const CONTROL_TIMEOUT_MS = 60_000;

/**
 * Statuses that mean the provider's edge never reached the service behind it,
 * so the same request can be sent again without first establishing whether it
 * landed. Everything else is an *answer*: a 4xx is the service saying no, and
 * repeating it changes nothing.
 *
 * Observed in the wild as a bare nginx `502 Bad Gateway` page from Daytona's
 * front door, which matters far past the call it interrupts - without this the
 * first one to land during a create settles, a resume, or a run's exec killed
 * the whole operation.
 */
const TRANSIENT_STATUSES = new Set([408, 429, 502, 503, 504]);

/**
 * Backoff between attempts at a transient failure, jittered on use.
 *
 * Short and bounded on purpose. This sits underneath poll loops that carry
 * their own deadline (`settle`), so the budget it adds has to be small enough
 * to disappear inside one poll interval; and a provider that is genuinely down
 * should surface as an error promptly rather than as a request that takes a
 * minute to fail. The jitter is not cosmetic: the container sync fans out over
 * every project at once, so a fixed backoff has every project retry in
 * lockstep and arrive as one burst.
 */
const RETRY_DELAYS_MS = [250, 750, 2000];

/**
 * Methods that may be re-sent on a transient failure purely from their own
 * semantics, with nothing else known about the endpoint.
 *
 * The default is deliberately conservative rather than clever: it leaves the
 * billable `POST /sandbox` and the command-starting `POST …/exec` out by
 * construction, so retrying either has to be an explicit, justified decision at
 * the call site rather than something a shared helper does on their behalf.
 */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'DELETE']);

/**
 * A response body reduced to one line, for embedding in an error message.
 *
 * Gateways answer with an HTML page rather than the API's JSON, so the raw body
 * turns a one-line failure into a six-line one - and this is a message that
 * lands in the log once per project per tick while an outage lasts. Collapsing
 * the whitespace keeps the diagnosis (the status and what the page said) and
 * drops the layout.
 */
function bodySnippet(text: string, maxLength = 400): string {
	const collapsed = text.replace(/\s+/g, ' ').trim();
	return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength)}…` : collapsed;
}

/**
 * Whether a thrown request failure is worth another attempt.
 *
 * An abort is excluded in both its forms - the caller cancelling, and this
 * attempt's own timeout. Neither is a blip: the first is a decision, and
 * retrying the second would stack whole control timeouts, taking a wedged call
 * far past the deadline whoever is waiting on it is measuring against. What
 * remains out of `fetch` is a transport failure (refused, reset, DNS, TLS),
 * which is precisely what a second attempt exists for.
 */
function isRetryableFailure(error: unknown): boolean {
	if (error instanceof DaytonaApiError) return TRANSIENT_STATUSES.has(error.status);
	const name = (error as { name?: string } | null)?.name;
	return name !== 'AbortError' && name !== 'TimeoutError';
}

/**
 * How many times a dropped command-log stream is resumed before the run is
 * failed. Bounded because every reconnect replays the log from byte 0 - the
 * endpoint offers no offset - so retrying a genuinely-down provider costs
 * increasingly more each time for increasingly less chance of success.
 */
const MAX_LOG_STREAM_RECONNECTS = 5;

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
 * How often an idle PTY socket is pinged.
 *
 * The tunnel rides this socket and carries **no bytes at all** while the agent
 * is thinking - minutes at a time for a coding CLI. Idle is precisely what a
 * load balancer or proxy reaps, and neither end is told: the container's
 * listeners stay bound, the host's multiplexer is gone, and the agent's next MCP
 * call hangs rather than failing. Well inside the 60s that intermediaries
 * commonly use.
 */
const PTY_KEEPALIVE_MS = 20_000;

/**
 * Deleting the PTY session is the only thing that kills the process on the far
 * end, so it is retried rather than attempted once - a silent failure leaves a
 * tunnel client holding this container's loopback ports with nothing on the
 * host still speaking to it.
 */
const PTY_DELETE_ATTEMPTS = 3;
const PTY_DELETE_RETRY_MS = 500;

/**
 * Largest single WebSocket message written to a PTY, and how much may sit
 * unflushed behind it.
 *
 * See {@link chunkPtyPayload} for the measurement: the far end of this socket is
 * a terminal, whose input queue is 4 KiB, and a larger message closes the
 * channel rather than being split for us. The tunnel's own frames are capped at
 * 64 KiB, so without this every catalogue-sized MCP response killed the tunnel a
 * couple of seconds into the run.
 *
 * The high-water mark is the second half of the same problem. `socket.send()`
 * queues, so chunking alone just hands the same bytes over in more pieces as
 * fast as the loop can run; the sender pauses when the socket has that much
 * still unflushed, which is the backpressure AGENTS.md asks for on an ignored
 * `send()` result. One frame's worth, so a single tunnel frame never blocks
 * mid-way through itself.
 */
const PTY_MAX_SEND_BYTES = 4 * 1024;
const PTY_SEND_HIGH_WATER_BYTES = 64 * 1024;
/** How long to wait between checks that the socket has drained. */
const PTY_DRAIN_POLL_MS = 5;
/** How long a single drain wait may run before it is reported as a stall.
 * Below git's own low-speed floor, so a clone blocked behind this channel is
 * diagnosed here before git abandons it. */
const PTY_DRAIN_WARN_MS = 10_000;

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

/**
 * The provider's wording for "the sandbox is not up, so I cannot route to it".
 *
 * Measured against the live API: a stopped or still-starting sandbox answers
 * **400**, not a transient status, with this in the body - so nothing generic
 * catches it and it read as a permanent failure of the run.
 */
const UNREACHABLE_BODY =
	/failed to resolve container IP|Is the Sandbox started\?|sandbox is not running/i;

/**
 * Raise the right class for a failed request.
 *
 * The unreachable shape becomes a backend-agnostic `ContainerUnreachableError`
 * here, inside the adapter, because a provider-named type may never be
 * classified above the `ContainerEngine` seam. 404 is excluded deliberately:
 * the engine turns "gone" into a null sandbox and raises its own error with
 * more context than the response has.
 */
function daytonaFailure(message: string, status: number, body: string): Error {
	if (status !== 404 && UNREACHABLE_BODY.test(body)) {
		return new ContainerUnreachableError(message);
	}
	return new DaytonaApiError(message, status, body);
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
	private readonly retryDelaysMs: number[];

	constructor(
		private readonly apiKey: string,
		private readonly apiUrl: string = DEFAULT_DAYTONA_API_URL,
		/** Test hook: overrides the transient-failure backoff so specs don't sleep. */
		opts: { retryDelaysMs?: number[] } = {},
	) {
		this.retryDelaysMs = opts.retryDelaysMs ?? RETRY_DELAYS_MS;
	}

	/**
	 * The one HTTP attempt loop every non-streaming call goes through.
	 *
	 * It owns exactly three things - the auth header, a **per-attempt** timeout,
	 * and the transient retry - and deliberately does not interpret the result.
	 * "Not ok" means something different at every endpoint here (a 404 from
	 * `files` is an answer, a 404 from the control plane is not; a 409 from
	 * session create means the session is already there and usable, a 409 from
	 * destroy means the sandbox is already gone), so the response is handed back
	 * for the caller to read. On give-up that means the caller raises its own
	 * named error carrying the transient status, exactly as it did before there
	 * was a retry at all.
	 *
	 * The timeout is minted per attempt rather than shared: one signal created
	 * outside the loop is already counting down when the second attempt starts,
	 * and would abort it instantly. A caller's own signal is combined with it, so
	 * supplying a cancel never costs the call its upper bound.
	 */
	private async send(
		method: string,
		url: string,
		init: {
			body?: BodyInit;
			headers?: Record<string, string>;
			timeoutMs?: number;
			/**
			 * A caller-owned cancel, combined with the per-attempt timeout rather
			 * than replacing it. Replacing it left every signalled call unbounded,
			 * and those are exactly the calls a run makes while holding a container
			 * and the credential lock.
			 */
			signal?: AbortSignal;
			/** Overrides the method-derived default. */
			retry?: boolean;
		} = {},
	): Promise<Response> {
		const retry = init.retry ?? IDEMPOTENT_METHODS.has(method.toUpperCase());
		const delays = retry ? this.retryDelaysMs : [];

		for (let attempt = 0; ; attempt++) {
			let failure: unknown;
			try {
				const res = await fetch(url, {
					method,
					headers: { Authorization: `Bearer ${this.apiKey}`, ...init.headers },
					body: init.body,
					signal: combineAbortSignals(
						init.signal,
						AbortSignal.timeout(init.timeoutMs ?? CONTROL_TIMEOUT_MS),
					),
				});
				if (res.ok || !TRANSIENT_STATUSES.has(res.status)) {
					if (attempt > 0) {
						log.debug(`${method} ${url} recovered on attempt ${attempt + 1}`);
					}
					return res;
				}
				if (attempt >= delays.length) return res;
				// Drained rather than abandoned: an unread body holds its connection
				// open, and this path runs on every sync tick during an outage.
				await res.arrayBuffer().catch(() => undefined);
				failure = new DaytonaApiError(`transient ${res.status}`, res.status, '');
			} catch (e) {
				if (attempt >= delays.length || !isRetryableFailure(e)) throw e;
				failure = e;
			}
			const base = delays[attempt];
			await new Promise((r) => setTimeout(r, base + Math.random() * base * 0.5));
			log.debug(
				`${method} ${url} retrying after ${(failure as Error).message} ` +
					`(attempt ${attempt + 2}/${delays.length + 1})`,
			);
		}
	}

	private async request<T>(
		method: string,
		path: string,
		body?: unknown,
		opts: { timeoutMs?: number; base?: string; retry?: boolean } = {},
	): Promise<T> {
		const base = opts.base ?? this.apiUrl;
		const res = await this.send(method, `${base}${path}`, {
			...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' } }),
			body: body === undefined ? undefined : JSON.stringify(body),
			timeoutMs: opts.timeoutMs,
			retry: opts.retry,
		});
		const text = await res.text();
		if (!res.ok) {
			// 403 is worth naming, because Daytona returns a bare "Access denied" for
			// a key missing a scope and that reads like an outage unless you know to
			// look at the key's permissions.
			const hint =
				res.status === 403
					? ' (the API key is likely missing a permission scope - volumes need read:volumes/write:volumes/delete:volumes)'
					: '';
			throw daytonaFailure(
				`Daytona ${method} ${path} failed (${res.status})${hint}: ${bodySnippet(text)}`,
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
			// Already gone is success. 409 is deliberately *not* folded in with it:
			// measured against the live API, both a sandbox mid-build and one whose
			// destroy has already been accepted answer 409, and the status alone
			// cannot tell them apart. Surfacing it is right for either - the caller
			// (the orphan reaper) retries, and a second destroy of something already
			// going away costs nothing.
			if (e instanceof DaytonaApiError && e.status === 404) return;
			throw e;
		}
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
		// Never retried: this runs a command, so a request that turns out to have
		// landed would run it a second time.
		const res = await this.send('POST', `${base}/process/execute`, {
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ command, ...(opts.cwd ? { cwd: opts.cwd } : {}) }),
			signal: opts.signal,
			timeoutMs: opts.timeoutMs,
		});
		const text = await res.text();
		if (!res.ok) {
			throw daytonaFailure(
				`Daytona execute failed (${res.status}): ${bodySnippet(text)}`,
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
		const sessionId = `hezo-${randomBytes(6).toString('hex')}`;

		// The one POST here that *is* retried, and it is safe for a reason specific
		// to this endpoint rather than to the method. The session id is minted on
		// this side, so a retry after a request that actually landed re-sends the
		// same id - and measured against the live API that answers `409` with
		// `code: "CONFLICT"` ("conflict: session already exists") while leaving the
		// session fully usable: the exec, its log stream and its command record all
		// work against it afterwards. So the conflict *is* the success case. Worth
		// having, because this is the first call of the exec every agent run, git
		// operation and chat turn goes through, and losing it to a gateway blip
		// fails the whole run.
		const created = await this.send('POST', `${base}/process/session`, {
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ sessionId }),
			signal: opts.signal,
			retry: true,
		});
		if (!created.ok && created.status !== 409) {
			// Reported rather than swallowed: every later call in this method is
			// addressed to a session that does not exist, so the real failure would
			// otherwise surface as a confusing "returned no cmdId" one step later.
			const body = await created.text();
			throw daytonaFailure(
				`Daytona session create failed (${created.status}): ${bodySnippet(body)}`,
				created.status,
				body,
			);
		}

		try {
			// Not retried, unlike the session create above: this one starts the
			// command, and a re-send of a request that landed runs it twice.
			const startRes = await this.send('POST', `${base}/process/session/${sessionId}/exec`, {
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					command: opts.cwd ? `cd ${JSON.stringify(opts.cwd)} && ${command}` : command,
					runAsync: true,
				}),
				signal: opts.signal,
			});
			const started = (await startRes.json()) as { cmdId?: string };
			const cmdId = started.cmdId;
			if (!cmdId) throw new Error('Daytona session exec returned no cmdId');

			await this.followCommandLog(
				`${base}/process/session/${sessionId}/command/${cmdId}/logs`,
				onLine,
				opts.signal,
			);

			// The follow stream ends when the command does; the exit code is only on
			// the command record, so it is fetched rather than parsed out of the logs.
			// By the time the stream has closed the record is final - measured, with
			// 7, 0, 127 and 1 all read back correctly on the first request.
			const infoRes = await this.send(
				'GET',
				`${base}/process/session/${sessionId}/command/${cmdId}`,
			);
			if (!infoRes.ok) {
				// Checked rather than parsed straight through. A gateway answers with
				// an HTML page, so `json()` would throw a bare SyntaxError naming
				// neither the provider nor the status - and any shape that *did* parse
				// would take the `?? 0` below and report a failed command as a clean
				// exit.
				const body = await infoRes.text();
				throw daytonaFailure(
					`Daytona command record fetch failed (${infoRes.status}): ${bodySnippet(body)}`,
					infoRes.status,
					body,
				);
			}
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

	/**
	 * Follow one command's log to completion, reconnecting where it left off if
	 * the stream drops.
	 *
	 * **Why it drops.** The stream is held open for the whole command, so it sits
	 * idle whenever the agent is thinking or waiting on a tool call - minutes at a
	 * time - and it is severed from both ends: a gateway in front of the provider
	 * reaps idle connections, and Bun's own `fetch` enforces a ~5 minute idle
	 * timeout that per-request options cannot disable (see `.dev/bun-issues.md`).
	 * Left unhandled either one killed the run outright, with Bun's `socket
	 * connection was closed unexpectedly` for a diagnosis.
	 *
	 * **The wait for response headers counts as idle too**, which is why the
	 * `fetch` itself is inside the retry rather than in front of it. Measured: the
	 * endpoint withholds headers until the command's first byte of output, so a
	 * CLI that is slow to start - or one that hangs - burns the idle budget before
	 * a single byte exists, and a throw there would end the run rather than
	 * reconnect. Same bounded counter covers it; nothing else needs to change.
	 *
	 * **How the resume is exact**, measured against the live API rather than read
	 * off the docs:
	 *
	 * - the endpoint has **no offset support at all** - `?offset`, `?from`,
	 *   `?since`, `?tail` and a `Range:` header are each accepted and *silently
	 *   ignored*, all returning the identical full log;
	 * - a reopened `follow=true` stream **replays from the first byte**, so a naive
	 *   reconnect would duplicate everything already emitted - double-counted token
	 *   usage and a re-emitted final assistant message;
	 * - but the log is append-only and complete from byte 0 on every read.
	 *
	 * So the resume is done here: reopen, and discard exactly the bytes already
	 * delivered. `delivered` is counted at **line** granularity, so the skip always
	 * lands on a line boundary and can never cut a multi-byte character in half.
	 * A replay shorter than what was already delivered would mean the provider
	 * truncated or rotated the log, which no byte offset can survive - that fails
	 * rather than emitting misaligned output.
	 *
	 * Bounded, because each reconnect re-sends the whole log: a provider that is
	 * genuinely down would otherwise retry forever at growing cost.
	 */
	private async followCommandLog(
		logsUrl: string,
		onLine: (line: string) => void | Promise<void>,
		signal?: AbortSignal,
	): Promise<void> {
		let delivered = 0;
		let reconnects = 0;

		for (;;) {
			// Deliberately no timeout: the stream stays open for the whole command,
			// and an agent run legitimately runs for its full budget. `signal` is how
			// a caller ends it early.
			let res: Response;
			try {
				res = await fetch(`${logsUrl}?follow=true`, {
					headers: { Authorization: `Bearer ${this.apiKey}` },
					signal,
				});
			} catch (e) {
				// A transport failure before any response, which the body loop below
				// cannot see. Reuses that loop's counter and backoff rather than adding
				// a second retry mechanism - the resume is identical either way, since
				// `delivered` is unchanged by a connection that carried nothing.
				if (signal?.aborted) throw e;
				reconnects += 1;
				if (reconnects > MAX_LOG_STREAM_RECONNECTS) {
					throw new ExecStreamLostError('Daytona session logs (no response headers)', { cause: e });
				}
				log.warn(
					`log stream failed before responding; retrying (attempt ${reconnects}/${MAX_LOG_STREAM_RECONNECTS})`,
				);
				await new Promise((r) => setTimeout(r, this.retryDelaysMs[0] ?? 0));
				continue;
			}
			// Checked **before** the body is touched, because a gateway failure here
			// is not an empty response - it is an HTML error page with a perfectly
			// good body, which the reader below would decode and hand to `onLine` as
			// the command's own output. That put `<html><head><title>502 Bad
			// Gateway</title>` into an agent's run log and then reported the exec as
			// a clean exit, since the stream ends and the exit code comes from a
			// separate call. A transient status feeds the reconnect counter that is
			// already here, so the bound and the backoff need no second mechanism.
			if (!res.ok) {
				await res.arrayBuffer().catch(() => undefined);
				if (!TRANSIENT_STATUSES.has(res.status)) {
					throw daytonaFailure(`Daytona command log stream failed (${res.status})`, res.status, '');
				}
				reconnects += 1;
				if (reconnects > MAX_LOG_STREAM_RECONNECTS) {
					throw new ExecStreamLostError(
						`Daytona session logs (gateway kept answering ${res.status})`,
					);
				}
				const backoff =
					this.retryDelaysMs[Math.min(reconnects - 1, this.retryDelaysMs.length - 1)] ?? 0;
				await new Promise((r) => setTimeout(r, backoff + Math.random() * backoff * 0.5));
				continue;
			}
			if (!res.body) return;

			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let skip = delivered;
			let buf = '';
			let done = false;

			try {
				for (;;) {
					const read = await reader.read();
					if (read.done) {
						done = true;
						break;
					}
					let chunk = read.value;
					if (!chunk) continue;
					// Drop the replayed prefix. It is byte-exact: `delivered` only ever
					// counts whole lines, so what remains starts at a line boundary.
					if (skip > 0) {
						if (chunk.byteLength <= skip) {
							skip -= chunk.byteLength;
							continue;
						}
						chunk = chunk.subarray(skip);
						skip = 0;
					}
					buf += decoder.decode(chunk, { stream: true });
					const lines = buf.split('\n');
					buf = lines.pop() ?? '';
					for (const line of lines) {
						delivered += Buffer.byteLength(`${line}\n`);
						await onLine(`${line}\n`);
					}
				}
			} catch (e) {
				if (signal?.aborted) throw e;
				reconnects += 1;
				if (reconnects > MAX_LOG_STREAM_RECONNECTS) {
					throw new ExecStreamLostError('Daytona session logs', { cause: e });
				}
				log.warn(
					`log stream dropped after ${delivered} byte(s); resuming (attempt ${reconnects}/${MAX_LOG_STREAM_RECONNECTS})`,
				);
				continue;
			} finally {
				reader.releaseLock();
			}

			if (done) {
				// The stream ends when the command does. Anything left in the buffer is
				// a final line with no trailing newline.
				if (skip > 0) {
					// The replay ran out before reaching where we had got to, so the log
					// is no longer the one we were reading. Nothing can realign it.
					throw new ExecStreamLostError('Daytona session logs (log truncated under us)');
				}
				if (buf) await onLine(buf);
				return;
			}
		}
	}

	/** End a command session, terminating the shell it holds. */
	private async deleteSession(sandbox: DaytonaSandbox, sessionId: string): Promise<void> {
		const base = await this.toolboxBase(sandbox);
		const res = await this.send(
			'DELETE',
			`${base}/process/session/${encodeURIComponent(sessionId)}`,
		);
		// A session that is already gone is the desired end state, not an error -
		// which is also what makes the retry above safe here: measured, a repeat
		// delete answers 404 `PROCESS_NOT_FOUND`, so a re-send of a request that
		// had already landed lands on this branch rather than failing the teardown.
		if (!res.ok && res.status !== 404) {
			const body = await res.text();
			throw daytonaFailure(`Daytona session delete failed (${res.status})`, res.status, body);
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
		// The only `send` whose response may not be discarded. Connecting the socket
		// to a session that was never created does not fail here - it fails as a
		// socket that closes on its own a moment later, which the tunnel reports as
		// "the exec channel carrying the tunnel closed" and the run as "the tunnel
		// client did not bind its ports within 30000ms". That names neither the
		// provider nor the status, and reads as the container being broken rather
		// than as one refused request.
		//
		// Not retried, unlike a GET: `send` retries only idempotent methods, and a
		// duplicate create carries a caller-chosen session id whose conflict
		// behaviour has not been measured against the live API. Failing by name is
		// the honest answer until it has been.
		const res = await this.send('POST', `${base}/process/pty`, {
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id: sessionId, cols: 200, rows: 50 }),
		});
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			throw daytonaFailure(
				`Daytona POST /process/pty failed (${res.status}): ${bodySnippet(text)}`,
				res.status,
				text,
			);
		}

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
		let ptyTextFramesAfterSync = 0;
		const ready = Promise.withResolvers<void>();

		socket.onmessage = (event) => {
			const frame = classifyPtyFrame(event.data);
			if (frame.kind === 'text' && synced) {
				// A framed binary protocol rides this channel once the handshake is
				// done, and a text frame cannot carry one: whatever produced it has
				// already UTF-8 decoded the bytes, so every sequence that was not
				// valid UTF-8 is now a replacement character and the original is
				// unrecoverable. Re-encoding it would feed that damage to the frame
				// decoder, which desynchronises and stalls rather than failing.
				//
				// Reported rather than refused for now, so a benign provider control
				// frame does not take down every run on this backend before we know
				// whether one exists; the count is what settles that.
				ptyTextFramesAfterSync += 1;
				log.warn(
					`Daytona PTY ${sessionId} delivered a text frame after the handshake ` +
						`(${frame.text.length} chars, starts ${JSON.stringify(frame.text.slice(0, 64))}); ` +
						'binary framing cannot survive this',
				);
			}
			const raw = frame.kind === 'binary' ? frame.bytes : new TextEncoder().encode(frame.text);
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
			clearInterval(keepalive);
			ready.reject(new Error('Daytona PTY closed before the launch completed'));
			onClose?.();
		};
		// Rebound now that the connect handshake has settled. It was set once above
		// for `connected`, and a post-connect error then resolved into an
		// already-settled promise - a no-op. In practice `close` follows `error` and
		// carried the signal, but that is the transport's habit rather than a
		// guarantee, and the one thing this channel must never do is die quietly.
		socket.onerror = () => {
			if (closed) return;
			log.warn(`Daytona PTY ${sessionId} errored; treating the channel as closed`);
			closed = true;
			clearInterval(keepalive);
			onClose?.();
		};

		// The tunnel carries **zero bytes** whenever the agent is thinking, which
		// for a coding CLI is minutes at a stretch - and an idle WebSocket is
		// exactly what an intermediary drops. Nothing then tells either end: the
		// container's listeners stay bound while the host's mux is gone, so the
		// agent's next MCP call hangs instead of failing. A periodic ping keeps the
		// connection observably alive rather than merely believed to be.
		const keepalive = setInterval(() => {
			if (closed) return;
			try {
				(socket as unknown as { ping?: () => void }).ping?.();
			} catch {
				// A transport without `ping` loses the keepalive, not the channel.
			}
		}, PTY_KEEPALIVE_MS);
		// Never hold the process open on this alone.
		(keepalive as unknown as { unref?: () => void }).unref?.();

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

		/**
		 * Writes are serialised through one chain, and paced.
		 *
		 * A framed protocol rides this channel, so order is not negotiable - two
		 * overlapping `send`s that interleaved their chunks would desynchronise the
		 * decoder, which is the same class of failure the sentinel handshake above
		 * exists to prevent. Chaining also makes the drain wait apply across calls
		 * rather than per call.
		 */
		let sendChain: Promise<void> = Promise.resolve();
		// A transport with no `bufferedAmount` cannot be paced; chunking still
		// applies, which is the half that stops the channel being closed outright.
		const buffered = () => (socket as unknown as { bufferedAmount?: number }).bufferedAmount ?? 0;
		const sendPaced = (data: Uint8Array) => {
			sendChain = sendChain
				.then(async () => {
					for (const chunk of chunkPtyPayload(data, PTY_MAX_SEND_BYTES)) {
						if (closed) return;
						socket.send(chunk);
						const waitStarted = Date.now();
						let reported = false;
						while (!closed && buffered() > PTY_SEND_HIGH_WATER_BYTES) {
							await new Promise((r) => setTimeout(r, PTY_DRAIN_POLL_MS));
							// This wait has no ceiling, by design - the alternative is
							// dropping bytes the framing layer has already counted. But an
							// unbounded wait that nobody can see is indistinguishable from
							// a hang, and the keepalive ping keeps the socket looking
							// healthy right through one, so say so once.
							if (!reported && Date.now() - waitStarted > PTY_DRAIN_WARN_MS) {
								reported = true;
								log.warn(
									`Daytona PTY ${sessionId} has waited ${Math.round((Date.now() - waitStarted) / 1000)}s ` +
										`for the socket to drain (${buffered()} byte(s) still queued); the far end is not reading`,
								);
							}
						}
					}
				})
				.catch((e) => {
					// A write that fails means the channel is gone; `onclose`/`onerror`
					// carry that to the caller, and rejecting this chain would only
					// strand every later write behind an unhandled rejection.
					log.warn(`Daytona PTY ${sessionId} write failed: ${(e as Error).message}`);
				});
		};

		return {
			send: sendPaced,
			onData: (handler) => {
				onData = handler;
			},
			onClose: (handler) => {
				onClose = handler;
			},
			close: () => {
				closed = true;
				clearInterval(keepalive);
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
				//
				// **Retried, not fire-and-once.** A delete that quietly failed left a
				// live client bound to those ports with the host side gone - so the
				// agent hung on MCP rather than getting a fast `ECONNREFUSED`, which
				// is strictly worse than the Docker failure mode. Still backgrounded:
				// teardown runs on the run's exit path and must not block it.
				trackBackground(
					this.deletePtySessionWithRetry(sandbox, sessionId).catch((e) => {
						log.error(
							`could not delete PTY session ${sessionId} after retries: ${(e as Error).message} - ` +
								'its client may still hold the tunnel ports on this container',
						);
					}),
				);
			},
		};
	}

	/**
	 * {@link deletePtySession} with bounded retries.
	 *
	 * The delete is the *only* thing that kills the process on the other end, so a
	 * single transient failure is not something to log and forget: it leaves a
	 * tunnel client alive, holding this container's three loopback ports, with
	 * nothing on the host still talking to it.
	 */
	private async deletePtySessionWithRetry(
		sandbox: DaytonaSandbox,
		sessionId: string,
	): Promise<void> {
		let lastError: unknown;
		for (let attempt = 0; attempt < PTY_DELETE_ATTEMPTS; attempt++) {
			try {
				await this.deletePtySession(sandbox, sessionId);
				return;
			} catch (e) {
				lastError = e;
				if (attempt < PTY_DELETE_ATTEMPTS - 1) {
					await new Promise((r) => setTimeout(r, PTY_DELETE_RETRY_MS * (attempt + 1)));
				}
			}
		}
		throw lastError;
	}

	/** End a PTY session, terminating whatever is running on it. */
	private async deletePtySession(sandbox: DaytonaSandbox, sessionId: string): Promise<void> {
		const base = await this.toolboxBase(sandbox);
		const res = await this.send('DELETE', `${base}/process/pty/${encodeURIComponent(sessionId)}`);
		// A session that is already gone is the desired end state, not an error.
		if (!res.ok && res.status !== 404) {
			throw daytonaFailure(
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
		// Reads and deletes carry the method default and retry; an upload does not,
		// since a re-sent write is a second write.
		const res = await this.send(method, `${base}${path}`, {
			body: init.body,
			timeoutMs: FILE_TIMEOUT_MS,
		});
		if (!res.ok && res.status !== 404) {
			const text = await res.text();
			throw daytonaFailure(
				`Daytona file ${method} ${path} failed (${res.status}): ${bodySnippet(text, 300)}`,
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

/** A PTY WebSocket message, classified rather than coerced. */
export type PtyFrame = { kind: 'binary'; bytes: Uint8Array } | { kind: 'text'; text: string };

/**
 * Classify a PTY WebSocket message without guessing at its type.
 *
 * The unchecked alternative - reading `event.data` as an `ArrayBuffer` whenever
 * it is not a string - is silent in two different ways, and a framed binary
 * protocol survives neither. A text frame has already been UTF-8 decoded by the
 * transport, so any sequence that was not valid UTF-8 is now a replacement
 * character and re-encoding cannot restore it. Anything that is neither a
 * string nor an `ArrayBuffer` - a `Blob`, which is what a runtime that ignores
 * `binaryType` hands back - yields a **zero-length** array rather than throwing,
 * so the entire message disappears without an error anywhere.
 *
 * Naming the three cases makes both of those loud instead.
 */
export function classifyPtyFrame(data: unknown): PtyFrame {
	if (typeof data === 'string') return { kind: 'text', text: data };
	if (data instanceof ArrayBuffer) return { kind: 'binary', bytes: new Uint8Array(data) };
	if (ArrayBuffer.isView(data)) {
		return {
			kind: 'binary',
			bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
		};
	}
	throw new Error(
		`Daytona PTY delivered an unsupported message type ${Object.prototype.toString.call(data)}`,
	);
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
