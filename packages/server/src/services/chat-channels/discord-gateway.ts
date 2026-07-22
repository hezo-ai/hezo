import { logger } from '../../logger';
import type { WebSocketLike } from './slack-socket';

const log = logger.child('chat-discord-gateway');

/**
 * Discord Gateway client — a zero-dependency transport over the WHATWG
 * `WebSocket` global, same seam pattern as the Slack Socket Mode client.
 *
 * Protocol: connect to the gateway URL → HELLO (op 10) carries the heartbeat
 * interval → IDENTIFY (op 2) with the bot token + intents → READY dispatch
 * carries `session_id` + `resume_gateway_url`. Heartbeats (op 1) carry the last
 * seen sequence number; the server acks with op 11. On RECONNECT (op 7) or a
 * resumable close, RESUME (op 6) replays missed dispatches; INVALID SESSION
 * (op 9) forces a fresh IDENTIFY.
 *
 * Unlike Slack's Socket Mode, the Discord gateway is TRUE FANOUT — every open
 * connection receives every event — so the ADAPTER must hold a single-instance
 * lease before starting this client (see `.dev` architecture notes).
 */

/** Gateway intents: guilds + guild messages + DMs + message content. */
export const DISCORD_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

const GATEWAY_VERSION = 'v=10&encoding=json';
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;

interface GatewayFrame {
	op?: number;
	t?: string | null;
	s?: number | null;
	d?: unknown;
}

/** What to do with one raw gateway frame. Pure decision logic — unit-tested directly. */
export interface GatewayDecision {
	/** HELLO: start heartbeating at this interval and identify/resume. */
	helloIntervalMs?: number;
	/** A dispatch (op 0): its event name + payload; sequence already recorded. */
	dispatch?: { name: string; data: unknown };
	/** New sequence number to track (op 0 frames carry one). */
	seq?: number;
	/** Server requested a reconnect (op 7) — resume on a fresh socket. */
	reconnect?: boolean;
	/** Session invalidated (op 9); `resumable` mirrors the frame's `d`. */
	invalidSession?: { resumable: boolean };
	/** Heartbeat ack (op 11) — the connection is healthy. */
	heartbeatAck?: boolean;
	/** Server asked for an immediate heartbeat (op 1). */
	heartbeatNow?: boolean;
}

/** Decide how to handle one raw gateway frame. Malformed frames are ignored. */
export function handleGatewayFrame(raw: unknown): GatewayDecision {
	if (typeof raw !== 'string') return {};
	let frame: GatewayFrame;
	try {
		frame = JSON.parse(raw) as GatewayFrame;
	} catch {
		return {};
	}
	if (!frame || typeof frame !== 'object') return {};
	switch (frame.op) {
		case 10: {
			const d = frame.d as { heartbeat_interval?: number } | undefined;
			return { helloIntervalMs: d?.heartbeat_interval ?? 41_250 };
		}
		case 0:
			return {
				dispatch: frame.t ? { name: frame.t, data: frame.d } : undefined,
				...(typeof frame.s === 'number' ? { seq: frame.s } : {}),
			};
		case 1:
			return { heartbeatNow: true };
		case 7:
			return { reconnect: true };
		case 9:
			return { invalidSession: { resumable: frame.d === true } };
		case 11:
			return { heartbeatAck: true };
		default:
			return {};
	}
}

export interface DiscordGatewayOptions {
	/** Read the current bot token (re-read on every connect — rotations apply live). */
	getToken: () => Promise<string>;
	/** Dispatched gateway events (`MESSAGE_CREATE`, `READY`, …) land here. Must not throw. */
	onDispatch: (name: string, data: unknown) => void;
	/** Renew the single-instance lease on each heartbeat; return false to stand down. */
	renewLease?: () => Promise<boolean>;
	/** Test seam; defaults to the WHATWG global. */
	webSocketFactory?: (url: string) => WebSocketLike;
	/** Base gateway URL (test seam); production default is Discord's. */
	gatewayUrl?: string;
}

export class DiscordGatewayClient {
	private running = false;
	private ws: WebSocketLike | null = null;
	private gen = 0;
	private attempt = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private seq: number | null = null;
	private sessionId: string | null = null;
	private resumeUrl: string | null = null;

	constructor(private readonly opts: DiscordGatewayOptions) {}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.attempt = 0;
		void this.connect(false);
	}

	stop(): void {
		this.running = false;
		this.gen++;
		this.clearTimers();
		try {
			this.ws?.close(1000, 'shutdown');
		} catch {
			// Already closed — nothing to release.
		}
		this.ws = null;
		this.seq = null;
		this.sessionId = null;
		this.resumeUrl = null;
	}

	isRunning(): boolean {
		return this.running;
	}

	private clearTimers(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	private async connect(resume: boolean): Promise<void> {
		if (!this.running) return;
		const gen = ++this.gen;
		this.clearTimers();
		const base = (resume && this.resumeUrl) || this.opts.gatewayUrl || 'wss://gateway.discord.gg';
		const url = `${base}${base.includes('?') ? '&' : '?'}${GATEWAY_VERSION}`;

		const factory =
			this.opts.webSocketFactory ?? ((u: string) => new WebSocket(u) as unknown as WebSocketLike);
		let ws: WebSocketLike;
		try {
			ws = factory(url);
		} catch (e) {
			log.warn('discord gateway: websocket open failed; retrying', e);
			this.scheduleReconnect(gen, false);
			return;
		}
		this.ws = ws;

		ws.addEventListener('message', (event) => {
			if (gen !== this.gen) return;
			void this.onFrame(ws, gen, event?.data, resume);
		});
		const onGone = () => {
			if (gen !== this.gen || !this.running) return;
			// A dropped socket is resumable when we hold a session.
			this.scheduleReconnect(gen, this.sessionId !== null);
		};
		ws.addEventListener('close', onGone);
		ws.addEventListener('error', onGone);
	}

	private async onFrame(
		ws: WebSocketLike,
		gen: number,
		data: unknown,
		resume: boolean,
	): Promise<void> {
		const raw = typeof data === 'string' ? data : data != null ? String(data) : '';
		const decision = handleGatewayFrame(raw);
		if (decision.seq !== undefined) this.seq = decision.seq;

		if (decision.helloIntervalMs !== undefined) {
			this.startHeartbeat(ws, gen, decision.helloIntervalMs);
			try {
				const token = await this.opts.getToken();
				if (gen !== this.gen) return;
				if (resume && this.sessionId) {
					ws.send(
						JSON.stringify({
							op: 6,
							d: { token, session_id: this.sessionId, seq: this.seq },
						}),
					);
				} else {
					ws.send(
						JSON.stringify({
							op: 2,
							d: {
								token,
								intents: DISCORD_INTENTS,
								properties: { os: 'linux', browser: 'hezo', device: 'hezo' },
							},
						}),
					);
				}
			} catch (e) {
				log.warn('discord gateway: identify failed; retrying', e);
				this.scheduleReconnect(gen, false);
			}
			return;
		}
		if (decision.heartbeatNow) {
			ws.send(JSON.stringify({ op: 1, d: this.seq }));
			return;
		}
		if (decision.reconnect) {
			try {
				ws.close(4000, 'reconnect requested');
			} catch {
				// Socket already gone; the close listener drives the reconnect.
			}
			if (gen === this.gen && this.running) {
				this.attempt = 0;
				void this.connect(true);
			}
			return;
		}
		if (decision.invalidSession) {
			this.sessionId = null;
			if (!decision.invalidSession.resumable) this.resumeUrl = null;
			try {
				ws.close(4000, 'invalid session');
			} catch {
				// Socket already gone.
			}
			if (gen === this.gen && this.running) {
				void this.connect(decision.invalidSession.resumable);
			}
			return;
		}
		if (decision.dispatch) {
			this.attempt = 0;
			if (decision.dispatch.name === 'READY') {
				const d = decision.dispatch.data as {
					session_id?: string;
					resume_gateway_url?: string;
				};
				this.sessionId = d?.session_id ?? null;
				this.resumeUrl = d?.resume_gateway_url ?? null;
				log.info('discord gateway connected');
			}
			try {
				this.opts.onDispatch(decision.dispatch.name, decision.dispatch.data);
			} catch (e) {
				log.error('discord gateway: onDispatch handler threw', e);
			}
		}
	}

	private startHeartbeat(ws: WebSocketLike, gen: number, intervalMs: number): void {
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = setInterval(() => {
			if (gen !== this.gen || !this.running) return;
			try {
				ws.send(JSON.stringify({ op: 1, d: this.seq }));
			} catch {
				// Send on a dead socket — the close listener reconnects.
			}
			// True-fanout gateway: keep proving we are the one instance allowed to
			// hold this connection; stand down if another holder took the lease.
			if (this.opts.renewLease) {
				void this.opts
					.renewLease()
					.then((ok) => {
						if (!ok && gen === this.gen) {
							log.warn('discord gateway: lost the instance lease; standing down');
							this.stop();
						}
					})
					.catch(() => undefined);
			}
		}, intervalMs);
	}

	private scheduleReconnect(gen: number, resume: boolean): void {
		if (!this.running || gen !== this.gen) return;
		this.clearTimers();
		const delay =
			Math.min(BACKOFF_BASE_MS * 2 ** this.attempt, BACKOFF_CAP_MS) * (0.5 + Math.random() * 0.5);
		this.attempt++;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			void this.connect(resume);
		}, delay);
	}
}
