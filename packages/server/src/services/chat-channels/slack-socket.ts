import { logger } from '../../logger';

const log = logger.child('chat-slack-socket');

/**
 * Slack Socket Mode client — a zero-dependency transport over the WHATWG
 * `WebSocket` global (present on both Bun, the production runtime, and Node ≥ 22,
 * the vitest runtime). The adapter owns one instance and drives it from
 * `start()`/`stop()`.
 *
 * Protocol: `apps.connections.open` (app-level `xapp-` token) mints a single-use
 * wss URL; Slack then delivers envelopes that must be acked within ~3s. Slack
 * refreshes connections every few minutes with a `disconnect` envelope, so
 * reconnecting is part of normal operation, not an error path. Slack also
 * load-balances events across an app's open Socket Mode connections, so a
 * duplicate process never double-delivers — no cross-instance ownership lease is
 * needed (unlike Discord's true-fanout gateway; see discord.ts / discord-gateway.ts).
 */

/** Minimal WebSocket surface the client needs — the injectable test seam. */
export interface WebSocketLike {
	send(data: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: string, listener: (event: MessageEventLike) => void): void;
}

interface MessageEventLike {
	data?: unknown;
}

/** What to do with one raw socket frame. Pure decision logic — unit-tested directly. */
export interface EnvelopeDecision {
	/** Envelope id to ack immediately (before any dispatch), if present. */
	ack?: string;
	/** The Events API inner event to dispatch, if this was an events_api envelope. */
	event?: unknown;
	/** Events API event id (`Ev…`) for redelivery dedupe. */
	eventId?: string;
	/** True on the `hello` frame — the connection is live; reset backoff. */
	hello?: boolean;
	/** Slack asked us to reconnect (refresh_requested etc.). */
	reconnect?: boolean;
}

/** Decide how to handle one raw Socket Mode frame. Malformed frames are ignored. */
export function handleEnvelope(raw: unknown): EnvelopeDecision {
	if (typeof raw !== 'string') return {};
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return {};
	}
	if (!parsed || typeof parsed !== 'object') return {};
	if (parsed.type === 'hello') return { hello: true };
	if (parsed.type === 'disconnect') return { reconnect: true };
	const decision: EnvelopeDecision = {};
	if (typeof parsed.envelope_id === 'string') decision.ack = parsed.envelope_id;
	if (parsed.type === 'events_api') {
		const payload = parsed.payload as Record<string, unknown> | undefined;
		if (payload && typeof payload === 'object') {
			decision.event = payload.event;
			if (typeof payload.event_id === 'string') decision.eventId = payload.event_id;
		}
	}
	// Other enveloped types (slash_commands, interactive) are acked and dropped.
	return decision;
}

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;
/** Recent event ids kept for redelivery dedupe (ack-first makes dupes rare). */
const DEDUPE_CAP = 500;

export interface SlackSocketClientOptions {
	/** Read the current app-level token (re-read on every reconnect — rotations apply live). */
	getAppToken: () => Promise<string>;
	/** Deduped Events API inner events land here. Must not throw. */
	onEvent: (event: unknown) => void;
	/** Test seam; defaults to the WHATWG global. */
	webSocketFactory?: (url: string) => WebSocketLike;
	/** Test seam; defaults to global fetch. */
	fetchFn?: typeof fetch;
}

export class SlackSocketClient {
	private running = false;
	private ws: WebSocketLike | null = null;
	/** Generation counter: stale sockets' listeners see a newer gen and go quiet. */
	private gen = 0;
	private attempt = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private seenEventIds = new Set<string>();

	constructor(private readonly opts: SlackSocketClientOptions) {}

	/** Bring the connection up (idempotent — a running client is left alone). */
	start(): void {
		if (this.running) return;
		this.running = true;
		this.attempt = 0;
		void this.connect();
	}

	/** Tear the connection down and stop reconnecting (idempotent). */
	stop(): void {
		this.running = false;
		this.gen++;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		try {
			this.ws?.close(1000, 'shutdown');
		} catch {
			// Already closed/failed — nothing to release.
		}
		this.ws = null;
	}

	/** Whether the client is currently trying to be connected. */
	isRunning(): boolean {
		return this.running;
	}

	private async connect(): Promise<void> {
		if (!this.running) return;
		const gen = ++this.gen;
		let url: string;
		try {
			url = await this.openConnectionUrl();
		} catch (e) {
			const message = (e as Error).message;
			// A rejected app token never self-heals — stop rather than hot-loop; the
			// operator sees it via save-time validateConfig.
			if (/invalid_auth|forbidden|account_inactive/.test(message)) {
				log.error(`slack socket: app token rejected (${message}); stopping`);
				this.running = false;
				return;
			}
			log.warn(`slack socket: connections.open failed (${message}); retrying`);
			this.scheduleReconnect(gen);
			return;
		}
		if (!this.running || gen !== this.gen) return;

		const factory =
			this.opts.webSocketFactory ?? ((u: string) => new WebSocket(u) as unknown as WebSocketLike);
		let ws: WebSocketLike;
		try {
			ws = factory(url);
		} catch (e) {
			log.warn('slack socket: websocket open failed; retrying', e);
			this.scheduleReconnect(gen);
			return;
		}
		this.ws = ws;

		ws.addEventListener('message', (event) => {
			if (gen !== this.gen) return;
			this.onFrame(ws, event?.data);
		});
		const onGone = () => {
			if (gen !== this.gen || !this.running) return;
			this.scheduleReconnect(gen);
		};
		ws.addEventListener('close', onGone);
		ws.addEventListener('error', onGone);
	}

	private onFrame(ws: WebSocketLike, data: unknown): void {
		const raw = typeof data === 'string' ? data : data != null ? String(data) : '';
		const decision = handleEnvelope(raw);
		// Ack FIRST — Slack redelivers unacked envelopes after ~3s, and dispatch
		// (a CEO turn) can take far longer than that.
		if (decision.ack) {
			try {
				ws.send(JSON.stringify({ envelope_id: decision.ack }));
			} catch (e) {
				log.warn('slack socket: ack failed', e);
			}
		}
		if (decision.hello) {
			this.attempt = 0;
			log.info('slack socket connected');
			return;
		}
		if (decision.reconnect) {
			// Slack-initiated refresh: reconnect immediately with a fresh ticket.
			const gen = this.gen;
			try {
				ws.close(1000, 'reconnecting');
			} catch {
				// Socket already gone — the close listener drives the reconnect anyway.
			}
			if (gen === this.gen && this.running) {
				this.attempt = 0;
				void this.connect();
			}
			return;
		}
		if (decision.event === undefined) return;
		if (decision.eventId) {
			if (this.seenEventIds.has(decision.eventId)) return;
			this.seenEventIds.add(decision.eventId);
			if (this.seenEventIds.size > DEDUPE_CAP) {
				const oldest = this.seenEventIds.values().next().value;
				if (oldest !== undefined) this.seenEventIds.delete(oldest);
			}
		}
		try {
			this.opts.onEvent(decision.event);
		} catch (e) {
			log.error('slack socket: onEvent handler threw', e);
		}
	}

	private scheduleReconnect(gen: number): void {
		if (!this.running || gen !== this.gen) return;
		const delay =
			Math.min(BACKOFF_BASE_MS * 2 ** this.attempt, BACKOFF_CAP_MS) * (0.5 + Math.random() * 0.5);
		this.attempt++;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			void this.connect();
		}, delay);
	}

	/** Mint a fresh single-use wss URL (tickets are never reusable across connects). */
	private async openConnectionUrl(): Promise<string> {
		const token = await this.opts.getAppToken();
		const fetchFn = this.opts.fetchFn ?? fetch;
		const res = await fetchFn('https://slack.com/api/apps.connections.open', {
			method: 'POST',
			headers: { authorization: `Bearer ${token}` },
		});
		const json = (await res.json().catch(() => null)) as {
			ok?: boolean;
			url?: string;
			error?: string;
		} | null;
		if (!res.ok || !json?.ok || !json.url) {
			throw new Error(json?.error ?? `http_${res.status}`);
		}
		return json.url;
	}
}
