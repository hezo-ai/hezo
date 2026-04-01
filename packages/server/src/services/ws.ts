export interface WsEvent {
	type: string;
	[key: string]: unknown;
}

export interface WsData {
	auth: {
		type: string;
		companyId?: string;
		userId?: string;
		memberId?: string;
		isSuperuser?: boolean;
	};
	rooms: Set<string>;
}

export interface WsSocket {
	data: WsData;
	send(msg: string): void;
}

export class WebSocketManager {
	private rooms = new Map<string, Set<WsSocket>>();

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
		for (const ws of sockets) {
			ws.send(msg);
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
