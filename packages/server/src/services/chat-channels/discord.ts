import { randomUUID } from 'node:crypto';
import { ChatChannel } from '@hezo/shared';
import { trackBackground } from '../../lib/background';
import { BoundedMap } from '../../lib/bounded-map';
import { logger } from '../../logger';
import { DiscordGatewayClient } from './discord-gateway';
import { splitMessageForLimit } from './format';
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

const log = logger.child('chat-discord');

/** Discord caps message content at 2000 chars; split a hair under it. */
const DISCORD_MESSAGE_LIMIT = 1_900;
/** Recent channel messages fetched as context on a mention. */
const DISCORD_CONTEXT_LIMIT = 25;
/** A gateway lease older than this is considered abandoned and can be taken. */
const LEASE_TTL_MS = 90_000;

/** Strip every mention of the bot (`<@id>` / `<@!id>`) and tidy whitespace. */
export function stripDiscordMention(text: string, botUserId: string | null): string {
	const pattern = botUserId ? new RegExp(`<@!?${botUserId}>`, 'g') : /<@!?\d+>/g;
	return text
		.replace(pattern, ' ')
		.replace(/[ \t]{2,}/g, ' ')
		.trim();
}

/** The Discord payload fields we read (REST + gateway share these shapes). */
interface DiscordMessage {
	id?: string;
	content?: string;
	channel_id?: string;
	guild_id?: string;
	timestamp?: string;
	author?: { id?: string; username?: string; global_name?: string; bot?: boolean };
	member?: { nick?: string };
	mentions?: Array<{ id?: string }>;
	referenced_message?: DiscordMessage | null;
}

function discordSenderName(msg: DiscordMessage): string {
	return (
		msg.member?.nick?.trim() ||
		msg.author?.global_name?.trim() ||
		msg.author?.username?.trim() ||
		String(msg.author?.id ?? 'unknown')
	);
}

/**
 * Discord chat channel adapter (gateway transport). Two modes:
 *
 * **Assistant** — a DM with the bot (one conversation per DM channel),
 * identity-allowlist gated like every DM surface.
 *
 * **Coworker** — @-mention the bot in any server channel it can see (or reply
 * to one of its messages). Channel history is fetched on demand via REST
 * (`GET /channels/{id}/messages`) — Discord, like Slack, can read back real
 * history, so there is no observed-message buffer. A message inside a Discord
 * thread carries the thread's own channel id, so threads are naturally their
 * own conversations. Server invite is the authorization.
 *
 * The gateway is TRUE FANOUT (every connection gets every event), so `start()`
 * takes a single-instance lease in `chat_channel_configs.metadata` and renews
 * it on each heartbeat — a second Hezo process stands down instead of
 * double-replying. Requires the Message Content intent on the bot.
 */
/** Ceiling on the per-workspace name/reply caches below. */
const NAME_CACHE_MAX = 2_000;

export class DiscordAdapter implements ChatChannelAdapter {
	readonly channel = ChatChannel.Discord;

	private gateway: DiscordGatewayClient | null = null;
	private botUserId: string | null = null;
	private readonly instanceId = randomUUID();
	// Bounded: keyed by channel id, so an unbounded map grows forever.
	private channelNames = new BoundedMap<string, string>(NAME_CACHE_MAX);
	// Last mention message id per channel, so `deliver` can reply-reference it.
	private replyTargets = new BoundedMap<string, string>(NAME_CACHE_MAX);

	constructor(private readonly deps: ChatChannelAdapterDeps) {}

	/** Seed the runtime cache `start()` normally fills (bot identity). Test seam. */
	primeRuntimeCache(botUserId: string | null): void {
		this.botUserId = botUserId;
	}

	private async api<T = unknown>(
		method: string,
		path: string,
		body?: Record<string, unknown>,
	): Promise<T | null> {
		const config = await loadChannelConfig(this.deps, this.channel);
		if (!config?.botTokenSecret) throw new Error('discord bot token not configured');
		const token = await decryptBotToken(this.deps, config.botTokenSecret);
		const res = await fetch(`https://discord.com/api/v10${path}`, {
			method,
			headers: {
				authorization: `Bot ${token}`,
				...(body ? { 'content-type': 'application/json' } : {}),
			},
			...(body ? { body: JSON.stringify(body) } : {}),
		});
		const json = (await res.json().catch(() => null)) as T | null;
		if (!res.ok) {
			log.error(`discord ${method} ${path} failed`, { status: res.status });
			return null;
		}
		return json;
	}

	async supportsGroupMode(): Promise<boolean> {
		const config = await loadChannelConfig(this.deps, this.channel);
		return (
			!!config?.enabled && !!config.botTokenSecret && config.metadata?.group_mode_enabled !== false
		);
	}

	private async dmModeEnabled(): Promise<boolean> {
		const config = await loadChannelConfig(this.deps, this.channel);
		return !!config?.enabled && config.metadata?.dm_mode_enabled !== false;
	}

	/**
	 * Take (or refresh) the single-instance gateway lease in channel metadata.
	 * Returns false when another live holder owns it.
	 */
	private async acquireLease(): Promise<boolean> {
		const r = await this.deps.db.query<{ metadata: Record<string, unknown> }>(
			`SELECT metadata FROM chat_channel_configs WHERE channel = 'discord'`,
		);
		const metadata = r.rows[0]?.metadata ?? {};
		const lease = metadata.gateway_owner as { id?: string; ts?: number } | undefined;
		const now = Date.now();
		if (lease?.id && lease.id !== this.instanceId && now - (lease.ts ?? 0) < LEASE_TTL_MS) {
			return false;
		}
		await this.deps.db.query(
			`UPDATE chat_channel_configs
			 SET metadata = metadata || $1::jsonb, updated_at = now()
			 WHERE channel = 'discord'`,
			[JSON.stringify({ gateway_owner: { id: this.instanceId, ts: now } })],
		);
		return true;
	}

	async start(): Promise<void> {
		const config = await loadChannelConfig(this.deps, this.channel);
		if (!config?.enabled || !config.botTokenSecret) {
			await this.stop();
			return;
		}
		await this.stop();

		const me = await this.api<{ id?: string }>('GET', '/users/@me');
		if (!me?.id) {
			log.warn('discord /users/@me failed; gateway not started');
			return;
		}
		this.botUserId = me.id;

		if (!(await this.acquireLease())) {
			log.warn('discord gateway lease held by another instance; standing down');
			return;
		}

		this.gateway = new DiscordGatewayClient({
			getToken: async () => {
				const cfg = await loadChannelConfig(this.deps, this.channel);
				if (!cfg?.botTokenSecret) throw new Error('discord bot token not configured');
				return decryptBotToken(this.deps, cfg.botTokenSecret);
			},
			onDispatch: (name, data) => this.routeDispatch(name, data),
			renewLease: () => this.acquireLease(),
		});
		this.gateway.start();
		log.info('discord gateway transport started');
	}

	async stop(): Promise<void> {
		this.gateway?.stop();
		this.gateway = null;
	}

	/** Route one gateway dispatch to the right ingest path (fire-and-forget). */
	private routeDispatch(name: string, data: unknown): void {
		if (name !== 'MESSAGE_CREATE') return;
		const sink = this.deps.sink;
		if (!sink) {
			log.warn('discord event dropped: no ingest sink wired');
			return;
		}
		const msg = data as DiscordMessage;
		if (msg.guild_id === undefined) {
			const parsed = this.parseInbound(data);
			if (!parsed) return;
			trackBackground(
				(async () => {
					if (!(await this.dmModeEnabled())) return;
					await sink.ingestDm(this, parsed);
				})().catch((e) => log.error('discord dm ingest failed', e)),
			);
			return;
		}
		const mention = this.parseGroupMention(data);
		if (!mention) return;
		trackBackground(
			(async () => {
				if (!(await this.supportsGroupMode())) return;
				await sink.ingestGroupMention(this, await this.enrichMention(mention));
			})().catch((e) => log.error('discord group mention ingest failed', e)),
		);
	}

	/** Resolve the channel name (cached REST lookup) onto a parsed mention. */
	private async enrichMention(event: InboundGroupMentionEvent): Promise<InboundGroupMentionEvent> {
		return { ...event, channelName: await this.channelName(event.externalThreadId) };
	}

	/** Assistant mode: a DM to the bot — one conversation per DM channel. */
	parseInbound(raw: unknown): InboundChatEvent | null {
		const msg = raw as DiscordMessage;
		if (msg?.guild_id !== undefined) return null;
		if (!msg?.content || !msg.author?.id || msg.author.bot || !msg.channel_id) return null;
		if (this.botUserId && msg.author.id === this.botUserId) return null;
		return {
			externalUserId: msg.author.id,
			externalThreadId: msg.channel_id,
			externalHandle: msg.author.username,
			text: msg.content,
		};
	}

	/**
	 * Coworker mode: a server message that mentions the bot or replies to one of
	 * its messages. The conversation is keyed by the Discord channel id — a
	 * message inside a Discord thread carries the thread's own channel id, so
	 * every thread is naturally its own conversation.
	 */
	parseGroupMention(raw: unknown): InboundGroupMentionEvent | null {
		const msg = raw as DiscordMessage;
		if (msg?.guild_id === undefined) return null;
		if (!msg?.content || !msg.author?.id || msg.author.bot || !msg.channel_id) return null;
		if (this.botUserId && msg.author.id === this.botUserId) return null;

		const mentioned =
			this.botUserId !== null &&
			((msg.mentions ?? []).some((m) => m.id === this.botUserId) ||
				msg.content.includes(`<@${this.botUserId}>`) ||
				msg.content.includes(`<@!${this.botUserId}>`));
		const repliedToBot =
			this.botUserId !== null && msg.referenced_message?.author?.id === this.botUserId;
		if (!mentioned && !repliedToBot) return null;

		const text = stripDiscordMention(msg.content, this.botUserId);
		if (text === '') return null;
		if (msg.id) this.replyTargets.set(msg.channel_id, msg.id);

		// One-hop quote of a replied-to human message as inline context.
		const quoted = msg.referenced_message;
		const inlineContext: ThreadContextMessage[] =
			quoted?.content && quoted.author && quoted.author.id !== this.botUserId && !quoted.author.bot
				? [{ sender: discordSenderName(quoted), text: quoted.content }]
				: [];

		return {
			externalUserId: msg.author.id,
			externalThreadId: msg.channel_id,
			externalHandle: msg.author.username,
			text,
			senderDisplayName: discordSenderName(msg),
			isThreadReply: msg.referenced_message != null,
			messageTs: msg.id,
			...(inlineContext.length > 0 ? { inlineContext } : {}),
		};
	}

	/** Fetch the channel's recent history via REST (newest-first → oldest-first). */
	async fetchThreadContext(event: InboundGroupMentionEvent): Promise<ThreadContextMessage[]> {
		const before = event.messageTs ? `&before=${event.messageTs}` : '';
		const rows = await this.api<DiscordMessage[]>(
			'GET',
			`/channels/${event.externalThreadId}/messages?limit=${DISCORD_CONTEXT_LIMIT}${before}`,
		);
		const out: ThreadContextMessage[] = [];
		for (const msg of (rows ?? []).reverse()) {
			if (!msg.content || !msg.author?.id || msg.author.bot) continue;
			if (this.botUserId && msg.author.id === this.botUserId) continue;
			if (this.botUserId && msg.content.includes(`<@${this.botUserId}>`)) continue;
			out.push({
				sender: discordSenderName(msg),
				text: msg.content,
				timestamp: msg.timestamp?.slice(0, 16).replace('T', ' '),
			});
		}
		return out;
	}

	async deliver(reply: OutboundReply): Promise<void> {
		// Anchor the answer to the message that asked, when known (consumed once).
		const replyTo = this.replyTargets.get(reply.externalThreadId);
		this.replyTargets.delete(reply.externalThreadId);
		const chunks = splitMessageForLimit(reply.content, DISCORD_MESSAGE_LIMIT);
		for (const [i, chunk] of chunks.entries()) {
			await this.api('POST', `/channels/${reply.externalThreadId}/messages`, {
				content: chunk,
				...(i === 0 && replyTo
					? { message_reference: { message_id: replyTo, fail_if_not_exists: false } }
					: {}),
			});
		}
	}

	/** DM-mode only: nudge an unlinked DM sender toward the identity allowlist. */
	async promptToLink(event: InboundChatEvent): Promise<void> {
		await this.api('POST', `/channels/${event.externalThreadId}/messages`, {
			content:
				'This Discord account is not linked to a Hezo user. Ask an admin to link it from the chat channels settings (Settings → your Discord user ID).',
		});
	}

	/** Save-time validation: prove the bot token against Discord. */
	async validateConfig(): Promise<{ ok: boolean; errors: string[] }> {
		const errors: string[] = [];
		const me = await this.api<{ id?: string }>('GET', '/users/@me').catch((e) => {
			errors.push(`bot token: ${(e as Error).message}`);
			return null;
		});
		if (!me?.id && errors.length === 0) errors.push('bot token: rejected by /users/@me');
		return { ok: errors.length === 0, errors };
	}

	/** Cached channel-name lookup ("#general"). */
	private async channelName(channelId: string): Promise<string | undefined> {
		const cached = this.channelNames.get(channelId);
		if (cached) return cached;
		const r = await this.api<{ name?: string }>('GET', `/channels/${channelId}`).catch(() => null);
		const name = r?.name ? `#${r.name}` : undefined;
		if (name) this.channelNames.set(channelId, name);
		return name;
	}
}
