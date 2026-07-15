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
 * Wire the manager's registry-wide channel hooks: deliver a message to any channel's
 * thread, create/close a channel's thread, and enumerate mirror-capable channels. The
 * manager stays channel-agnostic — it names only the `ChatChannel` enum value; the
 * registry resolves the adapter. This is what makes thread mirroring generic across
 * every channel (a new channel touches no manager code).
 */
export function wireManagerToChannels(
	manager: ChatSessionManager,
	registry: ChatChannelRegistry,
): void {
	manager.setChannelHooks({
		deliver: async (channel, externalThreadId, content, status) => {
			const adapter = registry.get(channel);
			if (adapter) await adapter.deliver({ externalThreadId, content, status });
		},
		closeThread: async (channel: ChatChannel, externalThreadId: string) => {
			const adapter = registry.get(channel);
			if (adapter?.closeThread) await adapter.closeThread(externalThreadId);
		},
		createThread: async (channel: ChatChannel, title: string) => {
			const adapter = registry.get(channel);
			return adapter?.createThread ? adapter.createThread(title) : null;
		},
		mirrorableChannels: () => registry.mirrorableChannels(),
	});
}
