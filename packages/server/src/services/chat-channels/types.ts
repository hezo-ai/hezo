import type { ChatChannel, ChatMessageStatus } from '@hezo/shared';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Db } from '../../db/database';

/**
 * A normalized inbound chat message from any external channel. Adapters translate
 * their platform's raw event shape into this so the shared ingest path
 * (`ingestInboundEvent`) is entirely channel-agnostic.
 */
export interface InboundChatEvent {
	/** Platform user id of the sender (Telegram from.id, Discord author.id, …). */
	externalUserId: string;
	/** Platform thread id this message belongs to (see the adapter's threading model). */
	externalThreadId: string;
	/** Display handle of the sender, for identity-link UIs. Optional. */
	externalHandle?: string;
	text: string;
}

/** A finalized assistant reply to deliver back out to an external channel. */
export interface OutboundReply {
	externalThreadId: string;
	content: string;
	status: ChatMessageStatus;
}

/**
 * A chat channel adapter owns *everything* platform-specific: inbound parsing,
 * outbound delivery, optional thread create/close, and any long-lived transport
 * (a webhook registration or a persistent gateway). The manager, webhook route,
 * config routes, and web core are all channel-agnostic and reach a channel only
 * through the adapter registered here — so a new chat app (Discord, Slack, …) is
 * one new adapter file, with no changes to the core.
 */
export interface ChatChannelAdapter {
	readonly channel: ChatChannel;

	/**
	 * Bring the channel online: register a webhook, open a gateway, etc. Called when
	 * the operator enables/saves the channel and on server unlock for enabled
	 * channels. Idempotent.
	 */
	start(): Promise<void>;
	/** Take the channel offline (deregister webhook, close gateway). Idempotent. */
	stop(): Promise<void>;

	/**
	 * Normalize a raw inbound platform event into an `InboundChatEvent`, or null to
	 * ignore it (a non-message update, the bot's own message, …). Pure — the webhook
	 * route/gateway feed the result to `ingestInboundEvent`.
	 */
	parseInbound(raw: unknown): InboundChatEvent | null;

	/** Deliver a finalized assistant reply to the platform thread. */
	deliver(reply: OutboundReply): Promise<void>;

	/** Prompt an unlinked sender to link their identity (best-effort, optional). */
	promptToLink?(event: InboundChatEvent): Promise<void>;

	/** Create a native platform thread, returning its id. No-op channels omit this. */
	createThread?(title: string): Promise<string>;
	/** Close/archive a native platform thread. No-op channels omit this. */
	closeThread?(externalThreadId: string): Promise<void>;

	/**
	 * Whether this channel can host mirrored threads *right now* (enabled + configured
	 * — e.g. Telegram with a Topics supergroup). Drives auto-mirroring: the manager
	 * only creates a thread here when this is true. Default (absent) = false.
	 */
	supportsThreads?(): Promise<boolean>;

	/**
	 * Parse a raw event as a *thread close* (e.g. a Telegram `forum_topic_closed`
	 * service message) → the external thread id that was closed, or null. Lets a topic
	 * closed on the platform close the mirrored web thread. Optional.
	 */
	parseClose?(raw: unknown): { externalThreadId: string } | null;
}

/**
 * Per-channel configuration row (mirrors `chat_channel_configs`). `metadata` holds
 * all channel-specific settings so no per-channel columns are ever needed.
 */
export interface ChatChannelConfig {
	channel: ChatChannel;
	enabled: boolean;
	botTokenSecret: string | null;
	webhookSecret: string | null;
	metadata: Record<string, unknown>;
}

/** Shared dependencies handed to every adapter at construction. */
export interface ChatChannelAdapterDeps {
	db: Db;
	masterKeyManager: MasterKeyManager;
}

/** Decrypt a bot token from the secrets vault in-process (trusted server code). */
export async function decryptBotToken(
	deps: ChatChannelAdapterDeps,
	secretName: string,
): Promise<string> {
	const key = deps.masterKeyManager.getKey();
	if (!key) throw new Error('server is locked; cannot read bot token');
	const r = await deps.db.query<{ encrypted_value: string }>(
		`SELECT encrypted_value FROM secrets WHERE name = $1`,
		[secretName],
	);
	const encrypted = r.rows[0]?.encrypted_value;
	if (!encrypted) throw new Error(`bot token secret ${secretName} not found`);
	const { decrypt } = await import('../../crypto/encryption');
	return decrypt(encrypted, key);
}

/** Load a channel's config row, or null when unconfigured. */
export async function loadChannelConfig(
	deps: ChatChannelAdapterDeps,
	channel: ChatChannel,
): Promise<ChatChannelConfig | null> {
	const r = await deps.db.query<{
		channel: ChatChannel;
		enabled: boolean;
		bot_token_secret: string | null;
		webhook_secret: string | null;
		metadata: Record<string, unknown>;
	}>(
		`SELECT channel, enabled, bot_token_secret, webhook_secret, metadata
		 FROM chat_channel_configs WHERE channel = $1`,
		[channel],
	);
	const row = r.rows[0];
	if (!row) return null;
	return {
		channel: row.channel,
		enabled: row.enabled,
		botTokenSecret: row.bot_token_secret,
		webhookSecret: row.webhook_secret,
		metadata: row.metadata ?? {},
	};
}
