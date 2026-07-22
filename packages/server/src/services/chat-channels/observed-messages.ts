import type { ChatChannel } from '@hezo/shared';
import type { Db } from '../../db/database';
import type { ThreadContextMessage } from './types';

/**
 * Bounded per-chat buffer of group messages the bot witnessed, for platforms
 * with no history API (Telegram: with BotFather privacy mode off the bot
 * receives every group message as an update). When the bot is later mentioned,
 * the buffer is read back as the ephemeral channel context — the honest
 * equivalent of Slack's on-demand `conversations.history`, limited to messages
 * seen since the bot joined.
 */

/** Newest rows kept per (channel, external chat). Pruned on every insert. */
export const OBSERVED_BUFFER_LIMIT = 200;

export interface ObservedMessageInput {
	channel: ChatChannel;
	/** Platform group/channel id (Telegram chat id). */
	externalChatId: string;
	/** Sub-scope inside the chat (a Telegram forum-topic id); null for plain groups. */
	threadScope: string | null;
	senderLabel: string;
	content: string;
	/** Platform message id, deduped on webhook retries. */
	messageTs: string | null;
}

/** Record one witnessed message and prune the chat's buffer to the cap. */
export async function recordObservedMessage(db: Db, input: ObservedMessageInput): Promise<void> {
	// Dedupe webhook redeliveries by platform message id.
	if (input.messageTs) {
		const dup = await db.query(
			`SELECT 1 FROM chat_observed_messages
			 WHERE channel = $1::chat_channel AND external_chat_id = $2 AND message_ts = $3`,
			[input.channel, input.externalChatId, input.messageTs],
		);
		if (dup.rows.length > 0) return;
	}
	await db.query(
		`INSERT INTO chat_observed_messages (channel, external_chat_id, thread_scope, sender_label, content, message_ts)
		 VALUES ($1::chat_channel, $2, $3, $4, $5, $6)`,
		[
			input.channel,
			input.externalChatId,
			input.threadScope,
			input.senderLabel,
			input.content,
			input.messageTs,
		],
	);
	// Keep only the newest rows per chat — the buffer is context, not an archive.
	await db.query(
		`DELETE FROM chat_observed_messages
		 WHERE channel = $1::chat_channel AND external_chat_id = $2
		   AND id NOT IN (
		     SELECT id FROM chat_observed_messages
		     WHERE channel = $1::chat_channel AND external_chat_id = $2
		     ORDER BY created_at DESC LIMIT $3
		   )`,
		[input.channel, input.externalChatId, OBSERVED_BUFFER_LIMIT],
	);
}

/**
 * Read a chat's observed buffer as prompt-ready context, oldest-first. A
 * topic-scoped read (Telegram forum topics) returns only that topic's messages;
 * an unscoped read returns the whole chat's buffer.
 */
export async function readObservedContext(
	db: Db,
	opts: {
		channel: ChatChannel;
		externalChatId: string;
		threadScope?: string | null;
		limit?: number;
	},
): Promise<ThreadContextMessage[]> {
	const limit = opts.limit ?? 50;
	const scoped = opts.threadScope != null;
	const r = await db.query<{ sender_label: string; content: string; stamp: string }>(
		`SELECT sender_label, content, to_char(created_at, 'YYYY-MM-DD HH24:MI') AS stamp
		 FROM chat_observed_messages
		 WHERE channel = $1::chat_channel AND external_chat_id = $2
		   ${scoped ? 'AND thread_scope = $4' : ''}
		 ORDER BY created_at DESC LIMIT $3`,
		scoped
			? [opts.channel, opts.externalChatId, limit, opts.threadScope]
			: [opts.channel, opts.externalChatId, limit],
	);
	return r.rows.reverse().map((row) => ({
		sender: row.sender_label,
		text: row.content,
		timestamp: row.stamp,
	}));
}
