import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

/**
 * A tiny external store for the app's live connection state, mirroring the
 * `useSyncExternalStore` pattern in `use-toast.ts`.
 *
 * It exists as a module-level store (not a React context) because the two sides
 * live in different trees: the WebSocket monitor writes from *inside*
 * `SocketProvider` (which owns the socket, mounted only after unlock + a valid
 * session), while the reader — the global `<Toaster />` — is mounted in
 * `main.tsx` *outside* the provider and the router, so it cannot call
 * `useSocket()`. This bridge lets the disconnect indicator render in the shared
 * top-right toast stack without threading the socket through the whole tree.
 */
export interface ConnectionState {
	/** True once the socket has dropped (after connecting at least once). */
	offline: boolean;
	/** Force an immediate reconnect — wired to the socket client's `reconnect()`. */
	retry: (() => void) | null;
}

const ONLINE: ConnectionState = { offline: false, retry: null };

let state: ConnectionState = ONLINE;
const listeners = new Set<(s: ConnectionState) => void>();

function emit() {
	for (const l of listeners) l(state);
}

/** Mark the connection as lost, carrying the retry action for "Retry now". */
export function setConnectionOffline(retry: () => void): void {
	if (state.offline && state.retry === retry) return;
	state = { offline: true, retry };
	emit();
}

/** Mark the connection as healthy again (also used to reset on provider unmount). */
export function setConnectionOnline(): void {
	if (!state.offline && state.retry === null) return;
	state = ONLINE;
	emit();
}

export function useConnectionStatus(): ConnectionState {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		() => state,
		() => state,
	);
}

/** How long the socket must stay down before we surface a disconnect. */
export const OFFLINE_DEBOUNCE_MS = 2000;

/**
 * Drive the connection store from two signals, covering "the internet dropped"
 * and "the server is unreachable" respectively:
 *   - `navigator.onLine` (window `offline`/`online` events) — a hard "no network"
 *     signal that fires even when an already-open socket hasn't yet noticed the
 *     drop (a half-open TCP connection can read OPEN for a while);
 *   - the socket's `connected` flag — catches a server that went away while the
 *     browser still has a network route.
 *
 * Debounces the offline transition so brief mobile blips (radio waking on
 * app-switch, cell↔wifi handoffs) don't flash the banner, and gates the socket
 * signal behind `hasConnectedOnce` so the initial connecting phase — and the
 * component-test harness, which stubs the WebSocket to a no-op that never opens —
 * never shows "offline". On unmount (logout/lock unmounts `SocketProvider`) it
 * resets the store so a stale disconnect can't bleed into the login / master-key
 * gate.
 *
 * Consumes only a boolean + a stable callback (like `useInvalidateOnReconnect`),
 * so it can be driven directly by a prop in tests.
 */
export function useConnectionMonitor(connected: boolean, reconnect: () => void): void {
	const hasConnectedOnce = useRef(false);
	if (connected) hasConnectedOnce.current = true;

	const [networkOnline, setNetworkOnline] = useState(() =>
		typeof navigator === 'undefined' ? true : navigator.onLine,
	);
	useEffect(() => {
		const goOnline = () => setNetworkOnline(true);
		const goOffline = () => setNetworkOnline(false);
		window.addEventListener('online', goOnline);
		window.addEventListener('offline', goOffline);
		return () => {
			window.removeEventListener('online', goOnline);
			window.removeEventListener('offline', goOffline);
		};
	}, []);

	// Disconnected when the browser reports no network, or the socket has dropped
	// after having connected at least once.
	const disconnected = !networkOnline || (hasConnectedOnce.current && !connected);

	useEffect(() => {
		if (!disconnected) {
			setConnectionOnline();
			return;
		}
		const id = setTimeout(() => setConnectionOffline(reconnect), OFFLINE_DEBOUNCE_MS);
		return () => clearTimeout(id);
	}, [disconnected, reconnect]);

	// Unmount-only: clear any surfaced disconnect when the provider tears down.
	useEffect(() => () => setConnectionOnline(), []);
}
