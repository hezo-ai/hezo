import { ChatChannel } from '@hezo/shared';
import { trackBackground } from '../../lib/background';
import { logger } from '../../logger';
import { splitMessageForLimit } from './format';
import { SlackSocketClient } from './slack-socket';
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

const log = logger.child('chat-slack');

/** Slack caps chat.postMessage text ~4k chars; split a hair under it. */
const SLACK_MESSAGE_LIMIT = 3_900;
/** Thread history fetched when a mention arrives inside an existing thread. */
const THREAD_CONTEXT_LIMIT = 100;
/** Recent channel messages fetched when a mention is top-level. */
const CHANNEL_CONTEXT_LIMIT = 25;

/**
 * Convert the CEO's markdown reply to Slack mrkdwn. Conservative by design
 * (mirrors Telegram's escape-everything philosophy): entity-escape, then map the
 * constructs Slack renders differently — bold, links, headings — and leave code
 * fences/inline code untouched. Pure — unit-tested directly.
 */
export function toSlackMrkdwn(text: string): string {
	// Split code out (fenced blocks and inline spans land at odd indices thanks to
	// the capture group) and transform only the prose segments between them.
	return text
		.split(/(```[\s\S]*?```|`[^`\n]*`)/g)
		.map((part, i) => {
			if (i % 2 === 1) return part;
			let out = part.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
			// [title](url) → <url|title>
			out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<$2|$1>');
			// **bold** → *bold*
			out = out.replace(/\*\*([^*]+)\*\*/g, '*$1*');
			// # Heading → *Heading*
			out = out.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');
			return out;
		})
		.join('');
}

/** Split a long reply on paragraph boundaries so every chunk fits Slack's cap. */
export function splitForSlack(text: string, limit = SLACK_MESSAGE_LIMIT): string[] {
	return splitMessageForLimit(text, limit);
}

/**
 * Encode a Slack thread id. A DM conversation is keyed by its bare `D…` channel
 * id (one conversation per DM, like a Telegram DM); a group/coworker thread is
 * `"<channelId>:<threadRootTs>"` — a top-level mention roots the thread at the
 * mention message itself, so the reply starts a thread and every later mention
 * in it resolves to the same conversation.
 */
export function encodeSlackThreadId(channelId: string, threadTs?: string): string {
	return threadTs ? `${channelId}:${threadTs}` : channelId;
}

export function decodeSlackThreadId(externalThreadId: string): {
	channelId: string;
	threadTs?: string;
} {
	const idx = externalThreadId.indexOf(':');
	if (idx === -1) return { channelId: externalThreadId };
	return { channelId: externalThreadId.slice(0, idx), threadTs: externalThreadId.slice(idx + 1) };
}

/** Strip every mention of the bot (`<@U…>`) from a message and tidy whitespace. */
export function stripBotMention(text: string, botUserId: string | null): string {
	const pattern = botUserId ? new RegExp(`<@${botUserId}(\\|[^>]*)?>`, 'g') : /<@[A-Z0-9]+>/g;
	return text
		.replace(pattern, ' ')
		.replace(/[ \t]{2,}/g, ' ')
		.trim();
}

/** Format a Slack `ts` ("1721.0001" epoch-seconds) as a short human timestamp. */
function formatSlackTs(ts: string | undefined): string | undefined {
	const seconds = Number(ts);
	if (!ts || Number.isNaN(seconds)) return undefined;
	return new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

/** The Slack event fields we read (Events API inner event shapes). */
interface SlackEvent {
	type?: string;
	subtype?: string;
	user?: string;
	bot_id?: string;
	text?: string;
	channel?: string;
	channel_type?: string;
	ts?: string;
	thread_ts?: string;
}

interface SlackApiResult {
	ok?: boolean;
	error?: string;
	[key: string]: unknown;
}

/**
 * Slack chat channel adapter (Socket Mode transport). Supports both integration
 * modes: DM/assistant mode (`message.im` → the assistant ingest path, identity
 * allowlist enforced, thread visible in the web chatbox) and group/coworker mode
 * (`app_mention` in a channel the bot was invited to → the coworker ingest path,
 * channel invite is the authorization, replies stay in the Slack thread).
 *
 * Config (`chat_channel_configs`): `bot_token_secret` = the `xoxb-` bot token;
 * `metadata.app_token_secret` = the `xapp-` app-level token (Socket Mode);
 * `metadata.dm_mode_enabled` / `metadata.group_mode_enabled` toggle the modes
 * (default on). Both tokens live in the secrets vault, decrypted in-process by
 * trusted server code; all calls go direct to slack.com (never the agent egress
 * proxy).
 */
export class SlackAdapter implements ChatChannelAdapter {
	readonly channel = ChatChannel.Slack;

	private socket: SlackSocketClient | null = null;
	private botUserId: string | null = null;
	private userNames = new Map<string, string>();
	private channelNames = new Map<string, string>();

	constructor(private readonly deps: ChatChannelAdapterDeps) {}

	private async api<T extends SlackApiResult = SlackApiResult>(
		method: string,
		body: Record<string, unknown> = {},
	): Promise<T | null> {
		const config = await loadChannelConfig(this.deps, this.channel);
		if (!config?.botTokenSecret) throw new Error('slack bot token not configured');
		const token = await decryptBotToken(this.deps, config.botTokenSecret);
		const res = await fetch(`https://slack.com/api/${method}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify(body),
		});
		const json = (await res.json().catch(() => null)) as T | null;
		if (!res.ok || !json?.ok) {
			log.error(`slack ${method} failed`, { status: res.status, error: json?.error });
			return null;
		}
		return json;
	}

	/** The app-level (`xapp-`) token secret name from channel metadata, if set. */
	private async appTokenSecret(): Promise<string | null> {
		const config = await loadChannelConfig(this.deps, this.channel);
		const name = config?.metadata?.app_token_secret;
		return typeof name === 'string' && name.trim() !== '' ? name : null;
	}

	private modeEnabled(metadata: Record<string, unknown>, key: string): boolean {
		return metadata[key] !== false;
	}

	async supportsGroupMode(): Promise<boolean> {
		const config = await loadChannelConfig(this.deps, this.channel);
		return (
			!!config?.enabled &&
			!!config.botTokenSecret &&
			(await this.appTokenSecret()) !== null &&
			this.modeEnabled(config.metadata, 'group_mode_enabled')
		);
	}

	private async dmModeEnabled(): Promise<boolean> {
		const config = await loadChannelConfig(this.deps, this.channel);
		return !!config?.enabled && this.modeEnabled(config.metadata, 'dm_mode_enabled');
	}

	async start(): Promise<void> {
		const config = await loadChannelConfig(this.deps, this.channel);
		const appSecret = await this.appTokenSecret();
		if (!config?.enabled || !config.botTokenSecret || !appSecret) {
			await this.stop();
			return;
		}
		// Restart cleanly on re-save so a rotated token applies.
		await this.stop();

		const identity = await this.api<SlackApiResult & { user_id?: string }>('auth.test');
		if (!identity) {
			log.warn('slack auth.test failed; socket not started');
			return;
		}
		this.botUserId = typeof identity.user_id === 'string' ? identity.user_id : null;

		this.socket = new SlackSocketClient({
			getAppToken: async () => {
				const name = await this.appTokenSecret();
				if (!name) throw new Error('slack app token not configured');
				return decryptBotToken(this.deps, name);
			},
			onEvent: (event) => this.routeEvent(event),
		});
		this.socket.start();
		log.info('slack socket mode transport started');
	}

	async stop(): Promise<void> {
		this.socket?.stop();
		this.socket = null;
	}

	/**
	 * Route one Events API inner event to the right ingest path. Fire-and-forget
	 * (tracked): a slow CEO turn must never stall the socket's frame loop.
	 */
	private routeEvent(raw: unknown): void {
		const sink = this.deps.sink;
		if (!sink) {
			log.warn('slack event dropped: no ingest sink wired');
			return;
		}
		const event = raw as SlackEvent;
		if (event?.type === 'app_mention') {
			const parsed = this.parseGroupMention(raw);
			if (!parsed) return;
			trackBackground(
				(async () => {
					if (!(await this.supportsGroupMode())) return;
					await sink.ingestGroupMention(this, await this.enrichMention(parsed));
				})().catch((e) => log.error('slack group mention ingest failed', e)),
			);
			return;
		}
		if (event?.type === 'message' && event.channel_type === 'im') {
			const parsed = this.parseInbound(raw);
			if (!parsed) return;
			trackBackground(
				(async () => {
					if (!(await this.dmModeEnabled())) return;
					await sink.ingestDm(this, parsed);
				})().catch((e) => log.error('slack dm ingest failed', e)),
			);
		}
	}

	/** Resolve display name + channel name (cached API lookups) onto a parsed mention. */
	private async enrichMention(event: InboundGroupMentionEvent): Promise<InboundGroupMentionEvent> {
		const { channelId } = decodeSlackThreadId(event.externalThreadId);
		return {
			...event,
			senderDisplayName: await this.displayName(event.externalUserId),
			channelName: await this.channelName(channelId),
		};
	}

	/**
	 * DM/assistant mode: a direct message to the bot. One conversation per DM
	 * channel (bare `D…` id), exactly like a Telegram DM — no thread hosting, so
	 * the conversation originates in Slack and is listed in the web chatbox.
	 */
	parseInbound(raw: unknown): InboundChatEvent | null {
		const event = raw as SlackEvent;
		if (event?.type !== 'message' || event.channel_type !== 'im') return null;
		if (event.subtype || event.bot_id) return null;
		if (!event.user || !event.text || !event.channel) return null;
		if (this.botUserId && event.user === this.botUserId) return null;
		return {
			externalUserId: event.user,
			externalThreadId: encodeSlackThreadId(event.channel),
			text: event.text,
		};
	}

	/** Group/coworker mode: an `app_mention` in a channel the bot was invited to. */
	parseGroupMention(raw: unknown): InboundGroupMentionEvent | null {
		const event = raw as SlackEvent;
		if (event?.type !== 'app_mention') return null;
		if (event.bot_id) return null;
		if (!event.user || !event.text || !event.channel || !event.ts) return null;
		if (this.botUserId && event.user === this.botUserId) return null;
		const text = stripBotMention(event.text, this.botUserId);
		if (text === '') return null;
		return {
			externalUserId: event.user,
			externalThreadId: encodeSlackThreadId(event.channel, event.thread_ts ?? event.ts),
			text,
			isThreadReply: !!event.thread_ts,
			messageTs: event.ts,
		};
	}

	/**
	 * Ephemeral context for one coworker turn: the full thread when the mention was
	 * a thread reply, else the channel's recent messages. Filters out the bot's own
	 * posts and prior bot-mentions (those are the persisted conversation window).
	 * Slack enforces the privacy model here — history is only readable in channels
	 * the bot is a member of.
	 */
	async fetchThreadContext(event: InboundGroupMentionEvent): Promise<ThreadContextMessage[]> {
		const { channelId, threadTs } = decodeSlackThreadId(event.externalThreadId);
		type HistoryResult = SlackApiResult & { messages?: SlackEvent[] };
		let messages: SlackEvent[];
		if (event.isThreadReply && threadTs) {
			const r = await this.api<HistoryResult>('conversations.replies', {
				channel: channelId,
				ts: threadTs,
				limit: THREAD_CONTEXT_LIMIT,
			});
			messages = r?.messages ?? []; // conversations.replies is oldest-first
		} else {
			const r = await this.api<HistoryResult>('conversations.history', {
				channel: channelId,
				limit: CHANNEL_CONTEXT_LIMIT,
			});
			messages = (r?.messages ?? []).reverse(); // history is newest-first
		}
		const out: ThreadContextMessage[] = [];
		for (const msg of messages) {
			if (!msg.text || !msg.user || msg.bot_id) continue;
			if (this.botUserId && msg.user === this.botUserId) continue;
			if (this.botUserId && msg.text.includes(`<@${this.botUserId}>`)) continue;
			out.push({
				sender: await this.displayName(msg.user),
				text: msg.text,
				timestamp: formatSlackTs(msg.ts),
			});
		}
		return out;
	}

	async deliver(reply: OutboundReply): Promise<void> {
		const { channelId, threadTs } = decodeSlackThreadId(reply.externalThreadId);
		for (const chunk of splitForSlack(toSlackMrkdwn(reply.content))) {
			await this.api('chat.postMessage', {
				channel: channelId,
				text: chunk,
				...(threadTs ? { thread_ts: threadTs } : {}),
			});
		}
	}

	/** DM-mode only: nudge an unlinked DM sender toward the identity allowlist. */
	async promptToLink(event: InboundChatEvent): Promise<void> {
		const { channelId } = decodeSlackThreadId(event.externalThreadId);
		await this.api('chat.postMessage', {
			channel: channelId,
			text: 'This Slack account is not linked to a Hezo user. Ask an admin to link it from the chat apps settings (your member ID is in your Slack profile → Copy member ID).',
		});
	}

	/** Save-time validation: prove both tokens against Slack before going live. */
	async validateConfig(): Promise<{ ok: boolean; errors: string[] }> {
		const errors: string[] = [];
		const identity = await this.api<SlackApiResult & { user_id?: string }>('auth.test').catch(
			(e) => {
				errors.push(`bot token: ${(e as Error).message}`);
				return null;
			},
		);
		if (!identity && errors.length === 0) errors.push('bot token: rejected by auth.test');
		const appSecret = await this.appTokenSecret();
		if (!appSecret) {
			errors.push('app token: not set (Socket Mode requires an xapp- app-level token)');
		} else {
			try {
				const token = await decryptBotToken(this.deps, appSecret);
				const res = await fetch('https://slack.com/api/apps.connections.open', {
					method: 'POST',
					headers: { authorization: `Bearer ${token}` },
				});
				const json = (await res.json().catch(() => null)) as SlackApiResult | null;
				if (!json?.ok) errors.push(`app token: ${json?.error ?? `http_${res.status}`}`);
			} catch (e) {
				errors.push(`app token: ${(e as Error).message}`);
			}
		}
		return { ok: errors.length === 0, errors };
	}

	/** Cached `users.info` display-name lookup; degrades to the raw id without `users:read`. */
	private async displayName(userId: string): Promise<string> {
		const cached = this.userNames.get(userId);
		if (cached) return cached;
		type UserResult = SlackApiResult & {
			user?: { profile?: { display_name?: string; real_name?: string }; name?: string };
		};
		const r = await this.api<UserResult>('users.info', { user: userId }).catch(() => null);
		const name =
			r?.user?.profile?.display_name?.trim() ||
			r?.user?.profile?.real_name?.trim() ||
			r?.user?.name?.trim() ||
			userId;
		this.userNames.set(userId, name);
		return name;
	}

	/** Cached `conversations.info` channel-name lookup (`#general`). */
	private async channelName(channelId: string): Promise<string | undefined> {
		const cached = this.channelNames.get(channelId);
		if (cached) return cached;
		type ChannelResult = SlackApiResult & { channel?: { name?: string } };
		const r = await this.api<ChannelResult>('conversations.info', { channel: channelId }).catch(
			() => null,
		);
		const name = r?.channel?.name ? `#${r.channel.name}` : undefined;
		if (name) this.channelNames.set(channelId, name);
		return name;
	}
}
