import type { ChatChannel } from '@hezo/shared';
import type { ChatSessionManager } from '../chat-session-manager';
import { DiscordAdapter } from './discord';
import type { IngestDeps } from './ingest';
import { ingestInboundEvent } from './ingest';
import { ingestGroupMentionEvent } from './ingest-group';
import { ChatChannelRegistry } from './registry';
import { SlackAdapter } from './slack';
import { TelegramAdapter } from './telegram';
import type { ChatChannelAdapterDeps, InboundEventSink } from './types';

export { type IngestDeps, ingestInboundEvent } from './ingest';
export { formatGroupContextBlock, ingestGroupMentionEvent } from './ingest-group';
export { ChatChannelRegistry } from './registry';
export type {
	ChatChannelAdapter,
	InboundChatEvent,
	InboundEventSink,
	InboundGroupMentionEvent,
	ThreadContextMessage,
} from './types';

/**
 * Build the adapter-side ingest sink for socket-transport adapters (a webhook
 * channel keeps flowing through `routes/chat-webhooks.ts`). Both paths resolve
 * through the same ingest functions the webhook route uses.
 */
export function buildInboundEventSink(deps: IngestDeps): InboundEventSink {
	return {
		ingestDm: (adapter, event) => ingestInboundEvent(deps, adapter, event),
		ingestGroupMention: (adapter, event) => ingestGroupMentionEvent(deps, adapter, event),
	};
}

/**
 * Build the channel-adapter registry with every shipped adapter registered.
 * Adding a channel = register one more adapter here (plus its adapter file).
 */
export function buildChatChannelRegistry(deps: ChatChannelAdapterDeps): ChatChannelRegistry {
	const registry = new ChatChannelRegistry();
	registry.register(new TelegramAdapter(deps));
	registry.register(new SlackAdapter(deps));
	registry.register(new DiscordAdapter(deps));
	return registry;
}

/**
 * Wire the manager's registry-wide channel hooks: deliver a reply to a channel's
 * thread (reply-where-asked) and close a channel's thread. The manager stays
 * channel-agnostic — it names only the `ChatChannel` enum value; the registry
 * resolves the adapter (a new channel touches no manager code).
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
	});
}
