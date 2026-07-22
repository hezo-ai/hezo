import { ChatChannel } from '@hezo/shared';
import { getInstanceBaseUrl } from '../../lib/system-meta';
import { logger } from '../../logger';
import { readObservedContext, recordObservedMessage } from './observed-messages';
import {
	type ChatChannelAdapter,
	type ChatChannelAdapterDeps,
	decryptBotToken,
	type InboundChatEvent,
	type InboundGroupMentionEvent,
	loadChannelConfig,
	type OutboundReply,
	type ThreadContextMessage,
} from './types';

const log = logger.child('chat-telegram');

/** Recent observed messages replayed as context on a group mention. */
const TELEGRAM_CONTEXT_LIMIT = 50;

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
 * need the sender, the chat, forum-topic threading, and the one-hop reply quote.
 */
interface TelegramUpdate {
	message?: TelegramMessage;
}

interface TelegramMessage {
	message_id?: number;
	text?: string;
	message_thread_id?: number;
	is_topic_message?: boolean;
	from?: TelegramUser;
	chat?: { id?: number; type?: string; title?: string };
	// The message this one replies to (one hop; Telegram nests no deeper).
	reply_to_message?: { message_id?: number; text?: string; from?: TelegramUser };
	// Service messages posted into a forum topic when it is closed/reopened.
	forum_topic_closed?: Record<string, unknown>;
}

interface TelegramUser {
	id?: number;
	username?: string;
	is_bot?: boolean;
	first_name?: string;
	last_name?: string;
}

/**
 * Encode a Telegram thread id from a chat id and optional forum-topic id. A DM (or
 * the General topic / a plain group) is keyed by the bare chat id; a forum topic is
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

/** Display name for a Telegram sender: full name, then @username, then the id. */
function senderName(from: TelegramUser | undefined): string {
	const name = [from?.first_name, from?.last_name].filter(Boolean).join(' ').trim();
	return name || (from?.username ? `@${from.username}` : String(from?.id ?? 'unknown'));
}

/**
 * Telegram chat channel adapter (webhook transport). Two modes:
 *
 * **Assistant** — a private DM with the bot (one conversation per DM), or a
 * topic in the operator's designated supergroup (`metadata.group_id`; one
 * conversation per topic — Telegram's native parallel threads). Identity
 * allowlist enforced by the DM ingest path.
 *
 * **Coworker** — any OTHER group/supergroup the bot is added to. Requires
 * BotFather privacy mode OFF so the bot receives group messages: it responds
 * when mentioned (`@botusername`) or when someone replies to one of its
 * messages, with the group's observed-message buffer as context (Telegram has
 * no history API — the bot can only replay what it has witnessed). Group invite
 * is the authorization; replies anchor to the triggering message.
 */
export class TelegramAdapter implements ChatChannelAdapter {
	readonly channel = ChatChannel.Telegram;

	// Bot identity + the designated assistant supergroup, cached by start() (the
	// parse methods are synchronous). Until start() succeeds, group mentions are
	// undetectable and non-DM chats are ignored — fail closed, never misroute.
	private botId: number | null = null;
	private botUsername: string | null = null;
	private designatedGroupId: string | null = null;
	// Last mention/reply message id per thread, so `deliver` can anchor the CEO's
	// answer to the message that asked (best-effort visual threading in groups).
	private replyTargets = new Map<string, number>();

	constructor(private readonly deps: ChatChannelAdapterDeps) {}

	/**
	 * Seed the runtime cache `start()` normally fills (bot identity + designated
	 * supergroup). Exposed so the pure parse methods are testable without a
	 * network; production code must not call it directly.
	 */
	primeRuntimeCache(
		identity: { id: number; username: string } | null,
		designatedGroupId: string | null,
	): void {
		this.botId = identity?.id ?? null;
		this.botUsername = identity?.username ?? null;
		this.designatedGroupId = designatedGroupId;
	}

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

	async start(): Promise<void> {
		const config = await loadChannelConfig(this.deps, this.channel);
		if (!config?.enabled || !config.botTokenSecret || !config.webhookSecret) {
			// Not fully configured / disabled — ensure no stale webhook is registered.
			await this.stop().catch(() => undefined);
			return;
		}
		// Cache the bot identity (mention detection) + the designated supergroup.
		const me = await this.api<{ id?: number; username?: string }>('getMe', {});
		if (me?.id && me.username) {
			this.botId = me.id;
			this.botUsername = me.username;
		} else {
			log.warn('telegram getMe failed; group mentions will be ignored until restart');
		}
		const gid = config.metadata?.group_id;
		this.designatedGroupId = typeof gid === 'string' && gid.trim() !== '' ? gid.trim() : null;

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
		this.botId = null;
		this.botUsername = null;
		this.designatedGroupId = null;
		// Best-effort: only possible when a token is still configured.
		const config = await loadChannelConfig(this.deps, this.channel);
		if (!config?.botTokenSecret) return;
		await this.api('deleteWebhook', {}).catch(() => undefined);
	}

	async supportsGroupMode(): Promise<boolean> {
		const config = await loadChannelConfig(this.deps, this.channel);
		return (
			!!config?.enabled && !!config.botTokenSecret && config.metadata?.group_mode_enabled !== false
		);
	}

	/** A `forum_topic_closed` service message → the topic that was closed on Telegram. */
	parseClose(raw: unknown): { externalThreadId: string } | null {
		const msg = (raw as TelegramUpdate)?.message;
		if (!msg?.forum_topic_closed || !msg.chat?.id || !msg.message_thread_id) return null;
		return { externalThreadId: encodeThreadId(msg.chat.id, msg.message_thread_id) };
	}

	/** True when the chat is the operator's designated assistant supergroup. */
	private isDesignatedGroup(chatId: number): boolean {
		return this.designatedGroupId !== null && String(chatId) === this.designatedGroupId;
	}

	/**
	 * Assistant-mode surfaces only: a private DM with the bot, or the designated
	 * supergroup's topics. Messages in any other group belong to coworker mode
	 * (or the observed buffer) — never the allowlisted DM path.
	 */
	parseInbound(raw: unknown): InboundChatEvent | null {
		const msg = (raw as TelegramUpdate)?.message;
		if (!msg?.text || !msg.from?.id || msg.from.is_bot || msg.chat?.id == null) return null;
		const isPrivate = msg.chat.type === 'private';
		if (!isPrivate && !this.isDesignatedGroup(msg.chat.id)) return null;
		return {
			externalUserId: String(msg.from.id),
			externalThreadId: encodeThreadId(msg.chat.id, msg.message_thread_id),
			externalHandle: msg.from.username ? `@${msg.from.username}` : undefined,
			text: msg.text,
		};
	}

	/**
	 * Coworker-mode trigger: a message in a non-designated group that mentions
	 * `@botusername` or replies to one of the bot's own messages. Threading: a
	 * forum-topic message keys `chatId:topicId` (one conversation per topic); a
	 * plain group keys the bare chat id (one conversation per group). Records the
	 * triggering message id so `deliver` can anchor the answer.
	 */
	parseGroupMention(raw: unknown): InboundGroupMentionEvent | null {
		const msg = (raw as TelegramUpdate)?.message;
		if (!msg?.text || !msg.from?.id || msg.from.is_bot || msg.chat?.id == null) return null;
		const chatType = msg.chat.type;
		if (chatType !== 'group' && chatType !== 'supergroup') return null;
		if (this.isDesignatedGroup(msg.chat.id)) return null;

		const username = this.botUsername;
		const mentioned = username ? new RegExp(`@${username}\\b`, 'i').test(msg.text) : false;
		const repliedToBot = this.botId !== null && msg.reply_to_message?.from?.id === this.botId;
		if (!mentioned && !repliedToBot) return null;

		const text = (username ? msg.text.replace(new RegExp(`@${username}\\b`, 'gi'), ' ') : msg.text)
			.replace(/[ \t]{2,}/g, ' ')
			.trim();
		if (text === '') return null;

		const externalThreadId = encodeThreadId(msg.chat.id, msg.message_thread_id);
		if (msg.message_id != null) this.replyTargets.set(externalThreadId, msg.message_id);

		// One-hop quote of a replied-to human message as inline context (the bot's
		// own replied-to messages already live in the persisted window).
		const quoted = msg.reply_to_message;
		const inlineContext: ThreadContextMessage[] =
			quoted?.text && quoted.from && quoted.from.id !== this.botId && !quoted.from.is_bot
				? [{ sender: senderName(quoted.from), text: quoted.text }]
				: [];

		return {
			externalUserId: String(msg.from.id),
			externalThreadId,
			externalHandle: msg.from.username ? `@${msg.from.username}` : undefined,
			text,
			senderDisplayName: senderName(msg.from),
			channelName: msg.chat.title,
			isThreadReply: msg.message_thread_id != null || msg.reply_to_message != null,
			messageTs: msg.message_id != null ? String(msg.message_id) : undefined,
			...(inlineContext.length > 0 ? { inlineContext } : {}),
		};
	}

	/**
	 * Buffer group chatter the bot witnessed (privacy mode off) for later mention
	 * context — Telegram has no history API, so the buffer IS the channel history.
	 * Only non-designated groups are recorded; DMs and the assistant supergroup
	 * flow through the DM path and are never buffered.
	 */
	async observeMessage(raw: unknown): Promise<void> {
		const msg = (raw as TelegramUpdate)?.message;
		if (!msg?.text || !msg.from || msg.from.is_bot || msg.chat?.id == null) return;
		const chatType = msg.chat.type;
		if (chatType !== 'group' && chatType !== 'supergroup') return;
		if (this.isDesignatedGroup(msg.chat.id)) return;
		if (!(await this.supportsGroupMode())) return;
		await recordObservedMessage(this.deps.db, {
			channel: this.channel,
			externalChatId: String(msg.chat.id),
			threadScope: msg.message_thread_id != null ? String(msg.message_thread_id) : null,
			senderLabel: senderName(msg.from),
			content: msg.text,
			messageTs: msg.message_id != null ? String(msg.message_id) : null,
		});
	}

	/** Replay the group's observed buffer (topic-scoped inside forum topics). */
	async fetchThreadContext(event: InboundGroupMentionEvent): Promise<ThreadContextMessage[]> {
		const { chatId, messageThreadId } = decodeThreadId(event.externalThreadId);
		return readObservedContext(this.deps.db, {
			channel: this.channel,
			externalChatId: chatId,
			threadScope: messageThreadId != null ? String(messageThreadId) : null,
			limit: TELEGRAM_CONTEXT_LIMIT,
		});
	}

	async deliver(reply: OutboundReply): Promise<void> {
		const { chatId, messageThreadId } = decodeThreadId(reply.externalThreadId);
		// Anchor the answer to the message that asked, when we know it (coworker
		// mentions). Consumed once so later unrelated replies don't chain onto it.
		const replyTo = this.replyTargets.get(reply.externalThreadId);
		this.replyTargets.delete(reply.externalThreadId);
		await this.api('sendMessage', {
			chat_id: chatId,
			text: escapeMarkdownV2(reply.content),
			parse_mode: 'MarkdownV2',
			...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
			...(replyTo ? { reply_to_message_id: replyTo, allow_sending_without_reply: true } : {}),
		});
	}

	async closeThread(externalThreadId: string): Promise<void> {
		const { chatId, messageThreadId } = decodeThreadId(externalThreadId);
		if (!messageThreadId) return; // A DM has no topic to close.
		// Only the designated assistant supergroup's topics are ours to archive —
		// closing a coworker thread must never touch the team's own group.
		if (this.designatedGroupId === null || chatId !== this.designatedGroupId) return;
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
