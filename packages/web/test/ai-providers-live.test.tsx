// The provider list can change with no request from this client: a hosting
// plan adds or withholds the managed credential while the instance runs, and
// the server says so on the global AI-provider room.
//
// The setup wizard is the screen that signal exists for, and the setup gate
// draws it *instead of* the shell. So the whole tree is rendered here, the
// server writes the managed row the way the policy follower does, and the only
// thing that tells this client is the signal. A subscription that lived in the
// shell would be unmounted for exactly the moment it was needed. The harness
// stubs the real socket, so its context is a stand-in that delivers a room's
// broadcast to a client that joined the room, as the server does.

import type { ManagedModelConfig } from '@hezo/server/src/config/types';
import { syncManagedModel } from '@hezo/server/src/services/managed-model';
import { WsMessageType, wsRoom } from '@hezo/shared';
import { waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';

const socket = vi.hoisted(() => {
	const handlers = new Map<string, Set<(msg: unknown) => void>>();
	const joined = new Set<string>();
	return {
		handlers,
		joined,
		/** The server's room broadcast: only a socket that joined the room hears it. */
		broadcast(room: string, msg: { type: string }) {
			if (!joined.has(room)) return;
			for (const h of handlers.get(msg.type) ?? []) h(msg);
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
		reconnect: () => {},
	};
	return {
		SocketProvider: ({ children }: { children: ReactNode }) => children,
		useSocket: () => value,
	};
});

const MANAGED: ManagedModelConfig = {
	baseUrl: 'https://models.example/api',
	model: 'vendor/one-model',
	apiKey: 'sk-managed',
	contextTokens: 1_048_576,
	requestHeaders: {},
};

/** What the server's policy follower does on a swap, then the signal it sends. */
async function planMoves(managed: ManagedModelConfig | null): Promise<void> {
	const { db, masterKeyManager } = getTestContext();
	await syncManagedModel(db, masterKeyManager, managed);
	socket.broadcast(wsRoom.aiProviders(), { type: WsMessageType.AiProvidersChanged });
}

afterEach(() => {
	socket.handlers.clear();
	socket.joined.clear();
});

test('an open setup wizard gives way when the plan brings the model back, and returns when it goes', async () => {
	const { findByTestId, queryByTestId } = await renderApp({
		initialPath: '/home',
		seed: async ({ db }) => {
			await db.query('DELETE FROM ai_provider_configs');
		},
	});

	// A box on a plan with the customer's own AI and nothing connected yet.
	await findByTestId('setup-step-ai-provider', undefined, { timeout: 15_000 });

	await planMoves(MANAGED);
	await findByTestId('app-header-chat', undefined, { timeout: 15_000 });
	expect(queryByTestId('setup-step-ai-provider')).toBeNull();

	// The shell is up now, and the next swap is heard as well, in the other
	// direction: the gate holds the room, and it stays mounted under the shell.
	await planMoves(null);
	await findByTestId('setup-step-ai-provider', undefined, { timeout: 15_000 });

	await planMoves(MANAGED);
	await waitFor(() => expect(queryByTestId('setup-step-ai-provider')).toBeNull(), {
		timeout: 15_000,
	});
	await findByTestId('app-header-chat');
});
