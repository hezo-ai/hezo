import type { WsMessageType, WsServerMessage } from '@hezo/shared';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useConnectionMonitor } from '../hooks/use-connection-status';
import { type MessageHandler, WebSocketClient } from '../lib/ws';

interface SocketContextValue {
	connected: boolean;
	subscribe: (type: WsMessageType, handler: MessageHandler) => () => void;
	joinRoom: (room: string) => void;
	leaveRoom: (room: string) => void;
	/** Force an immediate reconnect, bypassing the exponential-backoff wait. */
	reconnect: () => void;
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

		client.connect(token);

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

	const reconnect = useCallback(() => {
		clientRef.current.reconnect();
	}, []);

	return (
		<SocketContext value={{ connected, subscribe, joinRoom, leaveRoom, reconnect }}>
			<ConnectionMonitor connected={connected} reconnect={reconnect} />
			{children}
		</SocketContext>
	);
}

/**
 * Bridges the socket's `connected` flag into the module-level connection store
 * that the global `<Toaster />` reads (it's mounted outside this provider, so it
 * can't consume the context). Rendered here — not in `ShellLayout` — so it covers
 * the whole authenticated session, including the onboarding wizard above the shell.
 */
function ConnectionMonitor({
	connected,
	reconnect,
}: {
	connected: boolean;
	reconnect: () => void;
}) {
	useConnectionMonitor(connected, reconnect);
	return null;
}

export function useSocket(): SocketContextValue {
	const ctx = useContext(SocketContext);
	if (!ctx) throw new Error('useSocket must be used within SocketProvider');
	return ctx;
}
