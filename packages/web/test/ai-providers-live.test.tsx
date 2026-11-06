// The provider list can change with no request from this client: a hosting
// plan adds or withholds the managed credential while the instance runs, and
// the server says so on the global AI-provider room. Here the socket context is
// a controllable emitter, and the shell's socket hook is driven directly: the
// room is joined, and the signal marks every provider view stale.

import { WsMessageType, wsRoom } from '@hezo/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useShellWebSockets } from '../src/hooks/use-websocket';
import { queryClient } from '../src/lib/query-client';

const socket = vi.hoisted(() => {
	const handlers = new Map<string, Set<(msg: unknown) => void>>();
	const joined = new Set<string>();
	return {
		handlers,
		joined,
		emit(type: string, msg: unknown) {
			for (const h of handlers.get(type) ?? []) h(msg);
		},
	};
});

// One stable value, like the provider's memoised callbacks.
vi.mock('../src/contexts/socket-context', () => {
	const value = {
		connected: true,
		subscribe: (type: string, handler: (msg: unknown) => void) => {
			let set = socket.handlers.get(type);
			if (!set) {
				set = new Set();
				socket.handlers.set(type, set);
			}
			set.add(handler);
			return () => set?.delete(handler);
		},
		joinRoom: (room: string) => socket.joined.add(room),
		leaveRoom: (room: string) => socket.joined.delete(room),
	};
	return { useSocket: () => value };
});

function Shell() {
	useShellWebSockets(undefined);
	return null;
}

afterEach(() => {
	queryClient.clear();
	socket.handlers.clear();
	socket.joined.clear();
});

test('a provider-list signal marks every provider view stale, and nothing else', () => {
	// The keys `use-ai-providers` reads: the list, and the status the setup
	// screen gates on.
	queryClient.setQueryData(['ai-providers'], []);
	queryClient.setQueryData(['ai-providers', 'status'], { configured: false, providers: [] });
	queryClient.setQueryData(['unrelated'], 'kept');

	const { unmount } = render(
		<QueryClientProvider client={queryClient}>
			<Shell />
		</QueryClientProvider>,
	);
	expect(socket.joined.has(wsRoom.aiProviders())).toBe(true);

	socket.emit(WsMessageType.AiProvidersChanged, { type: WsMessageType.AiProvidersChanged });

	expect(queryClient.getQueryState(['ai-providers'])?.isInvalidated).toBe(true);
	expect(queryClient.getQueryState(['ai-providers', 'status'])?.isInvalidated).toBe(true);
	expect(queryClient.getQueryState(['unrelated'])?.isInvalidated).toBe(false);

	unmount();
	expect(socket.joined.has(wsRoom.aiProviders())).toBe(false);
});
