import type { ChatChannel, ChatMessageStatus } from '@hezo/shared';
import { decrypt, encrypt } from '../../crypto/encryption';
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

/**
 * A group/channel @-mention of the bot — the coworker-mode inbound event. Produced
 * by `parseGroupMention` on group-capable adapters and consumed by
 * `ingestGroupMentionEvent` (never by the DM ingest path).
 */
export interface InboundGroupMentionEvent extends InboundChatEvent {
	/** Human display name of the sender (falls back to externalHandle/externalUserId). */
	senderDisplayName?: string;
	/** Platform channel name for titles/labels, e.g. "#general". */
	channelName?: string;
	/** True when the mention arrived inside an existing platform thread. */
	isThreadReply: boolean;
	/** Platform message id (Slack ts / Telegram message_id), for logging/dedupe. */
	messageTs?: string;
	/**
	 * Context that arrived WITH the event itself — e.g. Telegram's one-hop quote
	 * of the message the mention replied to. The group ingest merges it ahead of
	 * any `fetchThreadContext` history into the same ephemeral prompt block.
	 */
	inlineContext?: ThreadContextMessage[];
}

/**
 * One message of ephemeral platform history an adapter fetched for a coworker-mode
 * turn. The adapter owns the platform fetch and its filtering; the core owns
 * formatting the list into the prompt (`formatGroupContextBlock`), so the prompt
 * shape is identical across channels.
 */
export interface ThreadContextMessage {
	/** Sender display name or handle. */
	sender: string;
	text: string;
	/** Human-readable timestamp, if the platform provides one. */
	timestamp?: string;
}

/** A finalized assistant reply to deliver back out to an external channel. */
export interface OutboundReply {
	externalThreadId: string;
	content: string;
	status: ChatMessageStatus;
}

/**
 * A chat channel adapter owns *everything* platform-specific: inbound parsing,
 * outbound delivery, and any long-lived transport (a webhook registration or a
 * persistent gateway). The manager, webhook route, config routes, and web core
 * are all channel-agnostic and reach a channel only through the adapter
 * registered here — so a new chat app is one new adapter file, with no changes
 * to the core. There is no thread mirroring: every conversation lives on one
 * surface, and replies are delivered to the surface each turn came from.
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

	/**
	 * Close/archive a native platform thread when the operator closes its
	 * conversation from the web view (e.g. a Telegram forum topic). Channels with
	 * nothing to close (DMs, Slack threads) omit this.
	 */
	closeThread?(externalThreadId: string): Promise<void>;

	/**
	 * Parse a raw event as a *thread close* (e.g. a Telegram `forum_topic_closed`
	 * service message) → the external thread id that was closed, or null. Lets a topic
	 * closed on the platform close the conversation here too. Optional.
	 */
	parseClose?(raw: unknown): { externalThreadId: string } | null;

	// --- Group / coworker mode (optional capability trio) ---
	// A channel that can host the CEO as a coworker in an existing group
	// channel/thread implements all three; a DM-only channel omits them and group
	// mode simply doesn't exist for it. These feed `ingestGroupMentionEvent`, never
	// the DM ingest path.

	/**
	 * Normalize a raw platform event into a group @-mention of the bot, or null to
	 * ignore (not a mention, the bot's own message, …). Pure — mention tokens are
	 * already stripped from `text`.
	 */
	parseGroupMention?(raw: unknown): InboundGroupMentionEvent | null;

	/**
	 * Whether group/coworker mode is live *right now* (enabled + configured + the
	 * mode not switched off in channel metadata). Default (absent) = false.
	 */
	supportsGroupMode?(): Promise<boolean>;

	/**
	 * Fetch the platform history surrounding a group mention as ephemeral context
	 * for this one turn (full thread when the mention is a thread reply, recent
	 * channel messages when top-level). Platforms with a history API (Slack,
	 * Discord) fetch on demand; platforms without one (Telegram) read the
	 * observed-message buffer their `observeMessage` hook accumulated. The adapter
	 * filters out the bot's own posts and prior bot-mention posts — those already
	 * live in the persisted conversation window. Oldest-first. Best-effort: the
	 * caller proceeds without context on failure.
	 */
	fetchThreadContext?(event: InboundGroupMentionEvent): Promise<ThreadContextMessage[]>;

	/**
	 * Record a group message the bot merely witnessed (no mention, no DM) into the
	 * bounded observed-message buffer, for platforms whose history can't be
	 * fetched retroactively. The webhook route calls this for raw updates no
	 * parser claimed; the adapter decides what (if anything) to store. Optional.
	 */
	observeMessage?(raw: unknown): Promise<void>;

	/**
	 * Validate the saved credentials against the platform (e.g. Slack `auth.test`).
	 * Called by the config route after save when enabling, so the operator sees a
	 * broken token immediately instead of a silent dead channel. Optional.
	 */
	validateConfig?(): Promise<{ ok: boolean; errors: string[] }>;
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

/**
 * The adapter-side path into the ingest layer, for adapters whose transport is a
 * persistent connection (a Slack Socket Mode client, a gateway) rather than the
 * generic webhook route. Webhook channels keep flowing through
 * `routes/chat-webhooks.ts`, which calls the ingest functions directly.
 */
export interface InboundEventSink {
	/** DM/assistant-mode message → the allowlisted assistant ingest path. */
	ingestDm(adapter: ChatChannelAdapter, event: InboundChatEvent): Promise<void>;
	/** Group @-mention → the coworker ingest path. */
	ingestGroupMention(adapter: ChatChannelAdapter, event: InboundGroupMentionEvent): Promise<void>;
}

/** Shared dependencies handed to every adapter at construction. */
export interface ChatChannelAdapterDeps {
	db: Db;
	masterKeyManager: MasterKeyManager;
	/** Present once the manager is wired; socket-transport adapters ingest through it. */
	sink?: InboundEventSink;
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

/**
 * Resolve a row's webhook secret, preferring the encrypted column and falling
 * back to the legacy plaintext one (migration 050).
 *
 * The fallback is the whole reason a live instance survives the upgrade: the
 * platform already holds a webhook URL containing this value, so it cannot be
 * rotated or invalidated on the operator's behalf. `backfillChatWebhookSecrets`
 * converts the row on the next unlock and nulls the plaintext; until then, and
 * whenever the instance is locked, the legacy value still authenticates.
 */
function resolveWebhookSecret(
	row: { webhook_secret: string | null; webhook_secret_encrypted: string | null },
	getKey: () => Buffer | null,
): string | null {
	// `getKey` is a thunk, not a value: a row that has not been converted yet has
	// nothing to decrypt, and this runs on the inbound-webhook path where the
	// master key is not otherwise needed.
	if (row.webhook_secret_encrypted) {
		const key = getKey();
		if (key) {
			try {
				return decrypt(row.webhook_secret_encrypted, key);
			} catch {
				// Ciphertext that will not open under the current key is unusable; fall
				// through to the legacy column rather than throwing on every webhook.
			}
		}
	}
	return row.webhook_secret;
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
		webhook_secret_encrypted: string | null;
		metadata: Record<string, unknown>;
	}>(
		`SELECT channel, enabled, bot_token_secret, webhook_secret, webhook_secret_encrypted, metadata
		 FROM chat_channel_configs WHERE channel = $1`,
		[channel],
	);
	const row = r.rows[0];
	if (!row) return null;
	return {
		channel: row.channel,
		enabled: row.enabled,
		botTokenSecret: row.bot_token_secret,
		webhookSecret: resolveWebhookSecret(row, () => deps.masterKeyManager.getKey()),
		metadata: row.metadata ?? {},
	};
}

/**
 * Re-encode any legacy plaintext `webhook_secret` into `webhook_secret_encrypted`
 * and null the plaintext. Runs on unlock (`startup.ts`), the first moment the
 * master key exists — migration 050 cannot do it, since migrations run at boot
 * while the instance is still locked.
 *
 * Idempotent and self-terminating: the `WHERE` matches only un-converted rows,
 * so after the first pass it updates nothing on every subsequent unlock.
 */
export async function backfillChatWebhookSecrets(deps: {
	db: Db;
	masterKeyManager: MasterKeyManager;
}): Promise<number> {
	const key = deps.masterKeyManager.getKey();
	if (!key) return 0;
	const pending = await deps.db.query<{ channel: ChatChannel; webhook_secret: string }>(
		`SELECT channel, webhook_secret FROM chat_channel_configs
		 WHERE webhook_secret IS NOT NULL AND webhook_secret_encrypted IS NULL`,
	);
	for (const row of pending.rows) {
		await deps.db.query(
			`UPDATE chat_channel_configs
			 SET webhook_secret_encrypted = $1, webhook_secret = NULL, updated_at = now()
			 WHERE channel = $2`,
			[encrypt(row.webhook_secret, key), row.channel],
		);
	}
	return pending.rows.length;
}
