import type { ChatChannel } from '@hezo/shared';
import { logger } from '../../logger';
import type { ChatChannelAdapter } from './types';

const log = logger.child('chat-channels');

/**
 * Registry of channel adapters, keyed by `ChatChannel`. The manager, webhook route,
 * and config routes all resolve a channel through this — there are no per-channel
 * branches in core code. Adding a channel = register one adapter here.
 */
export class ChatChannelRegistry {
	private adapters = new Map<ChatChannel, ChatChannelAdapter>();

	register(adapter: ChatChannelAdapter): void {
		this.adapters.set(adapter.channel, adapter);
	}

	get(channel: ChatChannel): ChatChannelAdapter | undefined {
		return this.adapters.get(channel);
	}

	all(): ChatChannelAdapter[] {
		return [...this.adapters.values()];
	}

	/** Start every registered adapter (called on server unlock). Failures are logged, not fatal. */
	async startAll(): Promise<void> {
		for (const adapter of this.adapters.values()) {
			try {
				await adapter.start();
			} catch (e) {
				log.error(`failed to start ${adapter.channel} chat channel`, e);
			}
		}
	}

	/** Stop every registered adapter (called on shutdown). */
	async stopAll(): Promise<void> {
		for (const adapter of this.adapters.values()) {
			try {
				await adapter.stop();
			} catch (e) {
				log.error(`failed to stop ${adapter.channel} chat channel`, e);
			}
		}
	}
}
