import {
	WsClientAction,
	type WsClientMessage,
	type WsMessageType,
	type WsServerMessage,
} from '@hezo/shared';
import ReconnectingWebSocket from 'reconnecting-websocket';
import { isPageHidden, subscribeToPageVisibility } from './page-lifecycle';

export type MessageHandler = (msg: WsServerMessage) => void;

/**
 * A page hidden longer than this is assumed to have been frozen by the OS, which kills
 * the connection without reliably surfacing a close event - the socket can still read
 * OPEN over a TCP connection that is already dead. Past this mark redial rather than
 * trust `readyState`; below it a brief tab switch leaves a healthy socket alone.
 */
export const RESUME_STALE_HIDDEN_MS = 30_000;

/**
 * How often an idle socket is probed. Doubles as a keepalive - carrier NAT and proxy
 * idle timers commonly reap a silent connection after 30-60s.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * How long a probe waits before the socket is declared dead. Any inbound frame counts
 * as proof of life, not just the pong, so a burst of log frames delaying the reply
 * cannot trip this.
 */
export const HEARTBEAT_TIMEOUT_MS = 5_000;

export class WebSocketClient {
	private ws: ReconnectingWebSocket | null = null;
	private handlers = new Map<WsMessageType, Set<MessageHandler>>();
	private subscribedRooms = new Set<string>();
	private token: string | null = null;
	private unsubscribeVisibility: (() => void) | null = null;
	private hiddenSince: number | null = null;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
	/** Bumped per dial; stale sockets' handlers compare against it. See `connect()`. */
	private generation = 0;
	onStatusChange?: (connected: boolean) => void;

	connect(token: string | null): void {
		this.token = token;
		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		const query = token ? `?token=${encodeURIComponent(token)}` : '';
		const url = `${protocol}//${window.location.host}/ws${query}`;

		const socket = new ReconnectingWebSocket(url, [], {
			maxReconnectionDelay: 10000,
			minReconnectionDelay: 1000,
			reconnectionDelayGrowFactor: 1.3,
			connectionTimeout: 4000,
			maxRetries: Infinity,
		});
		this.ws = socket;

		// Every handler below checks it belongs to the current dial first.
		// `reconnect()` closes the previous instance and immediately dials a new one,
		// and the old instance's `onclose` can land after the replacement has already
		// opened - which would otherwise report the fresh connection as down and park
		// its heartbeat. Counted rather than compared against `this.ws` so a test can
		// still swap in a fake socket and drive these handlers against it.
		const generation = ++this.generation;

		socket.onopen = () => {
			if (generation !== this.generation) return;
			this.onStatusChange?.(true);
			for (const room of this.subscribedRooms) {
				this.send({ action: WsClientAction.Subscribe, room });
			}
			this.startHeartbeat();
		};

		socket.onclose = () => {
			if (generation !== this.generation) return;
			this.stopHeartbeat();
			this.onStatusChange?.(false);
		};

		socket.onmessage = (event) => {
			if (generation !== this.generation) return;
			// Any inbound frame proves the peer is still there, so it settles a probe.
			this.clearHeartbeatTimeout();
			try {
				const msg = JSON.parse(event.data) as WsServerMessage;
				const typeHandlers = this.handlers.get(msg.type);
				if (typeHandlers) {
					for (const handler of typeHandlers) {
						handler(msg);
					}
				}
			} catch {
				// ignore malformed messages
			}
		};

		// One subscription per client, kept across `reconnect()` (which re-enters here).
		// Seeded from the current state so a client that starts life on an already-hidden
		// page still measures the background it is sitting in, rather than reading the
		// eventual resume as instantaneous.
		if (this.unsubscribeVisibility === null) {
			this.hiddenSince = isPageHidden() ? Date.now() : null;
			this.unsubscribeVisibility = subscribeToPageVisibility((hidden) =>
				this.handleVisibility(hidden),
			);
		}
	}

	disconnect(): void {
		this.stopHeartbeat();
		this.unsubscribeVisibility?.();
		this.unsubscribeVisibility = null;
		this.hiddenSince = null;
		this.ws?.close();
		this.ws = null;
		this.subscribedRooms.clear();
	}

	/**
	 * Foreground/background transitions.
	 *
	 * Backgrounding parks the heartbeat. Returning redials whenever the connection
	 * can't be trusted, so recovery costs one handshake instead of however long the
	 * backoff ladder had left to run - a delay the user would otherwise watch as a
	 * "Connection lost" notice on an app they just opened.
	 */
	private handleVisibility(hidden: boolean): void {
		if (hidden) {
			this.hiddenSince = Date.now();
			this.stopHeartbeat();
			return;
		}
		const hiddenFor = this.hiddenSince === null ? 0 : Date.now() - this.hiddenSince;
		this.hiddenSince = null;
		if (!this.ws) return; // deliberately disconnected; nothing to restore
		if (this.ws.readyState !== WebSocket.OPEN || hiddenFor >= RESUME_STALE_HIDDEN_MS) {
			this.reconnect();
			return;
		}
		this.startHeartbeat();
	}

	private startHeartbeat(): void {
		this.stopHeartbeat();
		// Paused while backgrounded: a probe loop that keeps waking the radio is the
		// battery cost this whole path exists to avoid.
		if (isPageHidden()) return;
		this.heartbeatTimer = setInterval(() => this.probe(), HEARTBEAT_INTERVAL_MS);
	}

	private probe(): void {
		if (this.ws?.readyState !== WebSocket.OPEN) return;
		this.send({ action: WsClientAction.Ping });
		if (this.heartbeatTimeout !== null) return; // a probe is already outstanding
		this.heartbeatTimeout = setTimeout(() => {
			this.heartbeatTimeout = null;
			this.reconnect();
		}, HEARTBEAT_TIMEOUT_MS);
	}

	private clearHeartbeatTimeout(): void {
		if (this.heartbeatTimeout === null) return;
		clearTimeout(this.heartbeatTimeout);
		this.heartbeatTimeout = null;
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer !== null) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
		this.clearHeartbeatTimeout();
	}

	/**
	 * Force an immediate reconnection, bypassing the exponential-backoff wait.
	 *
	 * We recreate the underlying `ReconnectingWebSocket` rather than call its
	 * `reconnect()`: during the backoff-wait window (exactly when a user clicks
	 * "Retry now") RWS holds an internal connect-lock and its `reconnect()`
	 * early-returns without pulling the pending dial earlier — a no-op precisely
	 * when it's needed. A fresh instance has a zero retry delay, so it dials at
	 * once. Unlike `disconnect()`, this preserves `subscribedRooms` and handlers,
	 * so `connect()`'s `onopen` replay loop re-subscribes to every joined room.
	 */
	reconnect(): void {
		this.stopHeartbeat();
		this.ws?.close();
		this.ws = null;
		this.connect(this.token);
	}

	subscribe(room: string): void {
		this.subscribedRooms.add(room);
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.send({ action: WsClientAction.Subscribe, room });
		}
	}

	unsubscribe(room: string): void {
		this.subscribedRooms.delete(room);
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.send({ action: WsClientAction.Unsubscribe, room });
		}
	}

	on(type: WsMessageType, handler: MessageHandler): () => void {
		let typeHandlers = this.handlers.get(type);
		if (!typeHandlers) {
			typeHandlers = new Set();
			this.handlers.set(type, typeHandlers);
		}
		typeHandlers.add(handler);
		const handlers = typeHandlers;
		return () => {
			handlers.delete(handler);
			if (handlers.size === 0) {
				this.handlers.delete(type);
			}
		};
	}

	get connected(): boolean {
		return this.ws?.readyState === WebSocket.OPEN;
	}

	private send(msg: WsClientMessage): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(msg));
		}
	}
}
