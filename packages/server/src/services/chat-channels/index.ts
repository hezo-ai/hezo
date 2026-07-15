import type { ChatChannel } from '@hezo/shared';
import type { ChatSessionManager } from '../chat-session-manager';
import { ChatChannelRegistry } from './registry';
import { TelegramAdapter } from './telegram';
import type { ChatChannelAdapterDeps } from './types';

export { type IngestDeps, ingestInboundEvent } from './ingest';
export { ChatChannelRegistry } from './registry';
export type { ChatChannelAdapter, InboundChatEvent } from './types';

/**
 * Build the channel-adapter registry with every shipped adapter registered.
 * Adding a channel = register one more adapter here (plus its adapter file).
 */
export function buildChatChannelRegistry(deps: ChatChannelAdapterDeps): ChatChannelRegistry {
	const registry = new ChatChannelRegistry();
	registry.register(new TelegramAdapter(deps));
	return registry;
}

/**
 * Wire the manager's external-channel hooks to the registry, so a finalized reply
 * on an external thread is delivered through that channel's adapter, and closing a
 * conversation closes the platform thread. The manager stays channel-agnostic —
 * it only knows the `ChatChannel` enum value, never a specific platform.
 */
export function wireManagerToChannels(
	manager: ChatSessionManager,
	registry: ChatChannelRegistry,
): void {
	manager.setChannelHooks({
		delivery: async (ctx, content, status) => {
			if (!ctx.externalThreadId) return;
			const adapter = registry.get(ctx.channel);
			if (!adapter) return;
			await adapter.deliver({ externalThreadId: ctx.externalThreadId, content, status });
		},
		closeThread: async (channel: ChatChannel, externalThreadId: string) => {
			const adapter = registry.get(channel);
			if (adapter?.closeThread) await adapter.closeThread(externalThreadId);
		},
	});
}
