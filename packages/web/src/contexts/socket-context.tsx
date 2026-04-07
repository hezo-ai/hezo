import type { WsMessageType, WsServerMessage } from '@hezo/shared';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { type MessageHandler, WebSocketClient } from '../lib/ws';

interface SocketContextValue {
	connected: boolean;
	subscribe: (type: WsMessageType, handler: MessageHandler) => () => void;
	joinRoom: (room: string) => void;
	leaveRoom: (room: string) => void;
}

const SocketContext = createContext<SocketContextValue | null>(null);

export function SocketProvider({
	token,
	children,
}: {
	token: string | null;
	children: React.ReactNode;
}) {
	const clientRef = useRef<WebSocketClient>(new WebSocketClient());
	const [connected, setConnected] = useState(false);

	useEffect(() => {
		const client = clientRef.current;
		client.onStatusChange = setConnected;

		if (token) {
			client.connect(token);
		} else {
			client.disconnect();
			setConnected(false);
		}

		return () => {
			client.disconnect();
			client.onStatusChange = undefined;
			setConnected(false);
		};
	}, [token]);

	const subscribe = useCallback((type: WsMessageType, handler: (msg: WsServerMessage) => void) => {
		return clientRef.current.on(type, handler);
	}, []);

	const joinRoom = useCallback((room: string) => {
		clientRef.current.subscribe(room);
	}, []);

	const leaveRoom = useCallback((room: string) => {
		clientRef.current.unsubscribe(room);
	}, []);

	return (
		<SocketContext value={{ connected, subscribe, joinRoom, leaveRoom }}>{children}</SocketContext>
	);
}

export function useSocket(): SocketContextValue {
	const ctx = useContext(SocketContext);
	if (!ctx) throw new Error('useSocket must be used within SocketProvider');
	return ctx;
}
