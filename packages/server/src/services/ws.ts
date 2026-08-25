export interface WsEvent {
	type: string;
	[key: string]: unknown;
}

export interface WsData {
	auth: {
		type: string;
		teamId?: string;
		userId?: string;
		memberId?: string;
		isSuperuser?: boolean;
	};
	rooms: Set<string>;
}

export interface WsSocket {
	data: WsData;
	/**
	 * Bun's ServerWebSocket.send returns bytes sent, 0 for a dropped frame, or
	 * -1 when the frame was only enqueued under backpressure. Test doubles may
	 * return nothing; a non-number result is treated as delivered.
	 */
	send(msg: string): number | void;
	/** Present on real sockets; used to shed a consumer that stopped draining. */
	close?(): void;
}

/**
 * Consecutive undelivered frames (dropped or enqueued-under-backpressure)
 * before a socket is shed. An ignored send() result is unbounded server-side
 * buffering: a consumer that stops draining otherwise queues every broadcast
 * in process memory forever. 100 frames bounds that to a burst's worth; the
 * client's ReconnectingWebSocket dials back in and resubscribes with a fresh
 * refetch, so shedding costs one reconnect, not data.
 */
const BACKPRESSURE_STRIKE_LIMIT = 100;

export class WebSocketManager {
	private rooms = new Map<string, Set<WsSocket>>();
	private strikes = new WeakMap<WsSocket, number>();

	subscribe(ws: WsSocket, room: string): void {
		let sockets = this.rooms.get(room);
		if (!sockets) {
			sockets = new Set();
			this.rooms.set(room, sockets);
		}
		sockets.add(ws);
		ws.data.rooms.add(room);
	}

	unsubscribe(ws: WsSocket, room: string): void {
		const sockets = this.rooms.get(room);
		if (sockets) {
			sockets.delete(ws);
			if (sockets.size === 0) this.rooms.delete(room);
		}
		ws.data.rooms.delete(room);
	}

	unsubscribeAll(ws: WsSocket): void {
		for (const room of ws.data.rooms) {
			const sockets = this.rooms.get(room);
			if (sockets) {
				sockets.delete(ws);
				if (sockets.size === 0) this.rooms.delete(room);
			}
		}
		ws.data.rooms.clear();
	}

	broadcast(room: string, event: WsEvent): void {
		const sockets = this.rooms.get(room);
		if (!sockets) return;
		const msg = JSON.stringify(event);
		// Iterate a copy: shedding a socket mutates the room set mid-loop.
		for (const ws of [...sockets]) {
			const result = ws.send(msg);
			if (typeof result !== 'number' || result > 0) {
				this.strikes.delete(ws);
				continue;
			}
			const strikes = (this.strikes.get(ws) ?? 0) + 1;
			if (strikes >= BACKPRESSURE_STRIKE_LIMIT) {
				this.strikes.delete(ws);
				this.unsubscribeAll(ws);
				ws.close?.();
			} else {
				this.strikes.set(ws, strikes);
			}
		}
	}

	getRoomSize(room: string): number {
		return this.rooms.get(room)?.size ?? 0;
	}

	getTotalConnections(): number {
		const unique = new Set<WsSocket>();
		for (const sockets of this.rooms.values()) {
			for (const ws of sockets) unique.add(ws);
		}
		return unique.size;
	}
}
