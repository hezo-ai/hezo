import { ChatChannel } from '@hezo/shared';
import { getInstanceBaseUrl } from '../../lib/system-meta';
import { logger } from '../../logger';
import {
	type ChatChannelAdapter,
	type ChatChannelAdapterDeps,
	decryptBotToken,
	type InboundChatEvent,
	loadChannelConfig,
	type OutboundReply,
} from './types';

const log = logger.child('chat-telegram');

/**
 * Escape text for Telegram's MarkdownV2 parse mode. Every one of the reserved
 * characters must be backslash-escaped outside an entity, or the API rejects the
 * message. We send fully-escaped plain text (no injected formatting) so delivery
 * is always safe; richer MarkdownV2 rendering (links from bare references) is a
 * follow-up. Pure — unit-tested directly.
 */
export function escapeMarkdownV2(text: string): string {
	return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);
}

/**
 * Telegram raw `message` update shape (the fields we read). Kept local — we only
 * need the sender, the chat, and forum-topic threading.
 */
interface TelegramUpdate {
	message?: {
		text?: string;
		message_thread_id?: number;
		is_topic_message?: boolean;
		from?: { id?: number; username?: string; is_bot?: boolean };
		chat?: { id?: number; type?: string };
		// Service messages posted into a forum topic when it is closed/reopened.
		forum_topic_closed?: Record<string, unknown>;
	};
}

/**
 * Encode a Telegram thread id from a chat id and optional forum-topic id. A DM (or
 * the General topic) is keyed by the bare chat id; a forum topic is
 * `"<chatId>:<messageThreadId>"`. Decoded symmetrically in `deliver`.
 */
function encodeThreadId(chatId: number, messageThreadId?: number): string {
	return messageThreadId ? `${chatId}:${messageThreadId}` : String(chatId);
}

function decodeThreadId(externalThreadId: string): { chatId: string; messageThreadId?: number } {
	const idx = externalThreadId.indexOf(':');
	if (idx === -1) return { chatId: externalThreadId };
	return {
		chatId: externalThreadId.slice(0, idx),
		messageThreadId: Number(externalThreadId.slice(idx + 1)),
	};
}

/**
 * Telegram chat channel adapter (webhook transport). Threading maps to Telegram's
 * one native primitive, forum topics: a private DM is a single conversation per
 * user; a Topics-enabled supergroup gives one conversation per topic. Creating and
 * closing topics needs the bot to be a group admin with `can_manage_topics`.
 */
export class TelegramAdapter implements ChatChannelAdapter {
	readonly channel = ChatChannel.Telegram;

	constructor(private readonly deps: ChatChannelAdapterDeps) {}

	private async api<T = unknown>(method: string, body: Record<string, unknown>): Promise<T | null> {
		const config = await loadChannelConfig(this.deps, this.channel);
		if (!config?.botTokenSecret) throw new Error('telegram bot token not configured');
		const token = await decryptBotToken(this.deps, config.botTokenSecret);
		const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
		const json = (await res.json().catch(() => null)) as { ok?: boolean; result?: T } | null;
		if (!res.ok || !json?.ok) {
			log.error(`telegram ${method} failed`, { status: res.status, body: json });
			return null;
		}
		return json.result ?? null;
	}

	/** The configured Topics supergroup id (in `metadata.group_id`), if any. */
	private async groupId(): Promise<string | null> {
		const config = await loadChannelConfig(this.deps, this.channel);
		const gid = config?.metadata?.group_id;
		return typeof gid === 'string' && gid.trim() !== '' ? gid : null;
	}

	/**
	 * Telegram can host mirrored threads when it's enabled, has a bot token, and a
	 * Topics supergroup is configured (`metadata.group_id`) — a DM can't hold topics.
	 */
	async supportsThreads(): Promise<boolean> {
		const config = await loadChannelConfig(this.deps, this.channel);
		return !!config?.enabled && !!config.botTokenSecret && (await this.groupId()) !== null;
	}

	async start(): Promise<void> {
		const config = await loadChannelConfig(this.deps, this.channel);
		if (!config?.enabled || !config.botTokenSecret || !config.webhookSecret) {
			// Not fully configured / disabled — ensure no stale webhook is registered.
			await this.stop().catch(() => undefined);
			return;
		}
		const baseUrl = await getInstanceBaseUrl(this.deps.db);
		if (!baseUrl) {
			log.warn('instance base URL unset; cannot register telegram webhook');
			return;
		}
		const url = `${baseUrl}/webhooks/chat/telegram/${config.webhookSecret}`;
		await this.api('setWebhook', {
			url,
			secret_token: config.webhookSecret,
			allowed_updates: ['message'],
		});
		log.info('telegram webhook registered');
	}

	async stop(): Promise<void> {
		// Best-effort: only possible when a token is still configured.
		const config = await loadChannelConfig(this.deps, this.channel);
		if (!config?.botTokenSecret) return;
		await this.api('deleteWebhook', {}).catch(() => undefined);
	}

	/** A `forum_topic_closed` service message → the topic that was closed on Telegram. */
	parseClose(raw: unknown): { externalThreadId: string } | null {
		const update = raw as TelegramUpdate;
		const msg = update?.message;
		if (!msg?.forum_topic_closed || !msg.chat?.id || !msg.message_thread_id) return null;
		return { externalThreadId: encodeThreadId(msg.chat.id, msg.message_thread_id) };
	}

	parseInbound(raw: unknown): InboundChatEvent | null {
		const update = raw as TelegramUpdate;
		const msg = update?.message;
		if (!msg?.text || !msg.from?.id || msg.from.is_bot || !msg.chat?.id) return null;
		return {
			externalUserId: String(msg.from.id),
			externalThreadId: encodeThreadId(msg.chat.id, msg.message_thread_id),
			externalHandle: msg.from.username ? `@${msg.from.username}` : undefined,
			text: msg.text,
		};
	}

	async deliver(reply: OutboundReply): Promise<void> {
		const { chatId, messageThreadId } = decodeThreadId(reply.externalThreadId);
		await this.api('sendMessage', {
			chat_id: chatId,
			text: escapeMarkdownV2(reply.content),
			parse_mode: 'MarkdownV2',
			...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
		});
	}

	async createThread(title: string): Promise<string> {
		const gid = await this.groupId();
		if (!gid) throw new Error('telegram: no Topics supergroup configured (metadata.group_id)');
		const result = await this.api<{ message_thread_id: number }>('createForumTopic', {
			chat_id: gid,
			name: title || 'New thread',
		});
		if (!result?.message_thread_id) throw new Error('telegram: createForumTopic returned no id');
		return encodeThreadId(Number(gid), result.message_thread_id);
	}

	async closeThread(externalThreadId: string): Promise<void> {
		const { chatId, messageThreadId } = decodeThreadId(externalThreadId);
		if (!messageThreadId) return; // A DM has no topic to close.
		await this.api('closeForumTopic', {
			chat_id: chatId,
			message_thread_id: messageThreadId,
		});
	}

	async promptToLink(event: InboundChatEvent): Promise<void> {
		const { chatId, messageThreadId } = decodeThreadId(event.externalThreadId);
		await this.api('sendMessage', {
			chat_id: chatId,
			text: escapeMarkdownV2(
				'This Telegram account is not linked to a Hezo user. Ask an admin to link it from the chat channels settings.',
			),
			parse_mode: 'MarkdownV2',
			...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
		});
	}
}
