import type { ChatChannel } from '@hezo/shared';
import type { Db } from '../../db/database';
import { logger } from '../../logger';
import type { ChatSessionManager } from '../chat-session-manager';
import type { ChatChannelAdapter, InboundChatEvent } from './types';

const log = logger.child('chat-channels');

export interface IngestDeps {
	db: Db;
	manager: ChatSessionManager;
}

/**
 * Resolve an external sender to a linked Hezo user, or null if not on the
 * allowlist. `(channel, external_user_id)` is unique, so at most one row.
 * Exported for the group ingest path, where a link is optional enrichment
 * (attribution), never a gate.
 */
export async function resolveLinkedUser(
	db: Db,
	channel: ChatChannel,
	externalUserId: string,
): Promise<string | null> {
	const r = await db.query<{ user_id: string }>(
		`SELECT user_id FROM chat_identity_links WHERE channel = $1 AND external_user_id = $2`,
		[channel, externalUserId],
	);
	return r.rows[0]?.user_id ?? null;
}

/**
 * The single, channel-agnostic entry point for an inbound external chat message.
 * Every adapter (webhook route or gateway) feeds its parsed `InboundChatEvent`
 * here. Enforces the identity allowlist, then routes the message to the CEO chat
 * as a turn on the conversation keyed by the external thread.
 *
 * An unlinked sender is not served: the adapter is asked to prompt them to link
 * (best-effort) and no turn is started.
 */
export async function ingestInboundEvent(
	deps: IngestDeps,
	adapter: ChatChannelAdapter,
	event: InboundChatEvent,
): Promise<void> {
	const channel = adapter.channel;
	const userId = await resolveLinkedUser(deps.db, channel, event.externalUserId);
	if (!userId) {
		log.info(`ignoring ${channel} message from unlinked identity`, {
			externalUserId: event.externalUserId,
		});
		if (adapter.promptToLink) {
			await adapter.promptToLink(event).catch((e) => log.error('promptToLink failed', e));
		}
		return;
	}
	await deps.manager.sendTurn({
		text: event.text,
		channel,
		externalThreadId: event.externalThreadId,
		authorUserId: userId,
	});
}
