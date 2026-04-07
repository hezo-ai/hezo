import {
	WsClientAction,
	type WsClientMessage,
	type WsMessageType,
	type WsServerMessage,
} from '@hezo/shared';
import ReconnectingWebSocket from 'reconnecting-websocket';

export type MessageHandler = (msg: WsServerMessage) => void;

export class WebSocketClient {
	private ws: ReconnectingWebSocket | null = null;
	private handlers = new Map<WsMessageType, Set<MessageHandler>>();
	private subscribedRooms = new Set<string>();
	onStatusChange?: (connected: boolean) => void;

	connect(token: string): void {
		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		const url = `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;

		this.ws = new ReconnectingWebSocket(url, [], {
			maxReconnectionDelay: 10000,
			minReconnectionDelay: 1000,
			reconnectionDelayGrowFactor: 1.3,
			connectionTimeout: 4000,
			maxRetries: Infinity,
		});

		this.ws.onopen = () => {
			this.onStatusChange?.(true);
			for (const room of this.subscribedRooms) {
				this.send({ action: WsClientAction.Subscribe, room });
			}
		};

		this.ws.onclose = () => {
			this.onStatusChange?.(false);
		};

		this.ws.onmessage = (event) => {
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
	}

	disconnect(): void {
		this.ws?.close();
		this.ws = null;
		this.subscribedRooms.clear();
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
