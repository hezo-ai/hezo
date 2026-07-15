import { randomUUID } from 'node:crypto';
import { type ChatChannel, isChatChannel } from '@hezo/shared';
import { Hono } from 'hono';
import { encrypt } from '../crypto/encryption';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { requireAdminEquivalent } from '../middleware/auth';

const log = logger.child('chat-channels-routes');

/**
 * Operator/admin surface for configuring external chat channels (bot config) and
 * the identity allowlist. These are superuser-only and channel-agnostic — every
 * mutation resolves the channel through the adapter registry, so a new channel
 * needs no route changes. There is no agent-facing MCP equivalent.
 */
export const chatChannelRoutes = new Hono<Env>();

/** Upstream host a channel's bot token is scoped to in the secrets vault. */
const CHANNEL_HOST: Record<string, string> = {
	telegram: 'api.telegram.org',
	discord: 'discord.com',
};

/** Canonical secrets-vault name for a channel's bot token, e.g. TELEGRAM_BOT_TOKEN. */
function botTokenSecretName(channel: ChatChannel): string {
	return `${channel.toUpperCase()}_BOT_TOKEN`;
}

chatChannelRoutes.get('/chat/channels', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	const rows = await c.get('db').query<{
		channel: string;
		enabled: boolean;
		bot_token_secret: string | null;
		webhook_secret: string | null;
		metadata: Record<string, unknown>;
		updated_at: string;
	}>(
		`SELECT channel, enabled, bot_token_secret, webhook_secret, metadata, updated_at
		 FROM chat_channel_configs ORDER BY channel`,
	);
	// Never return the raw token or webhook secret — just whether they're set.
	return ok(c, {
		channels: rows.rows.map((r) => ({
			channel: r.channel,
			enabled: r.enabled,
			has_token: !!r.bot_token_secret,
			has_webhook: !!r.webhook_secret,
			metadata: r.metadata ?? {},
			updated_at: r.updated_at,
		})),
	});
});

// Configure a channel: store the bot token in the secrets vault, upsert the config
// row, and bring the adapter online (or offline when disabled).
chatChannelRoutes.put('/chat/channels/:channel', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	const channelParam = c.req.param('channel');
	if (!isChatChannel(channelParam) || channelParam === 'web') {
		return err(c, 'INVALID_REQUEST', 'unknown external channel', 400);
	}
	const channel: ChatChannel = channelParam;

	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');
	const key = masterKeyManager.getKey();
	if (!key) return err(c, 'LOCKED', 'Server must be unlocked to configure channels', 401);

	const body = await c.req.json<{
		enabled?: boolean;
		bot_token?: string;
		metadata?: Record<string, unknown>;
	}>();
	const enabled = !!body.enabled;
	const metadata = body.metadata ?? {};

	// Store/rotate the bot token in the vault when provided, scoped to the platform
	// host. Trusted server code decrypts it in-process for outbound API calls.
	let botTokenSecret: string | null = null;
	if (body.bot_token?.trim()) {
		const name = botTokenSecretName(channel);
		await db.query(
			`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts, allow_all_hosts, allow_body_substitution)
			 VALUES ($1, $2, 'api_token', $3, false, false)
			 ON CONFLICT (name) DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value, updated_at = now()`,
			[name, encrypt(body.bot_token.trim(), key), [CHANNEL_HOST[channel] ?? '']],
		);
		botTokenSecret = name;
	}

	// Reuse an existing webhook secret if present; otherwise mint one on first setup.
	const existing = await db.query<{
		webhook_secret: string | null;
		bot_token_secret: string | null;
	}>(`SELECT webhook_secret, bot_token_secret FROM chat_channel_configs WHERE channel = $1`, [
		channel,
	]);
	const webhookSecret = existing.rows[0]?.webhook_secret ?? randomUUID().replace(/-/g, '');
	if (!botTokenSecret) botTokenSecret = existing.rows[0]?.bot_token_secret ?? null;

	await db.query(
		`INSERT INTO chat_channel_configs (channel, enabled, bot_token_secret, webhook_secret, metadata)
		 VALUES ($1, $2, $3, $4, $5::jsonb)
		 ON CONFLICT (channel) DO UPDATE
		 SET enabled = EXCLUDED.enabled, bot_token_secret = EXCLUDED.bot_token_secret,
		     webhook_secret = EXCLUDED.webhook_secret, metadata = EXCLUDED.metadata, updated_at = now()`,
		[channel, enabled, botTokenSecret, webhookSecret, JSON.stringify(metadata)],
	);

	// Bring the adapter online/offline to match. Best-effort — surfaced via logs; the
	// config is already persisted so a retry (or restart) reconciles.
	const adapter = c.get('chatChannelRegistry')?.get(channel);
	if (adapter) {
		await (enabled ? adapter.start() : adapter.stop()).catch((e) =>
			log.error(`failed to ${enabled ? 'start' : 'stop'} ${channel}`, e),
		);
	}
	return ok(c, { channel, enabled, has_token: !!botTokenSecret });
});

// Disable a channel and take its adapter offline.
chatChannelRoutes.delete('/chat/channels/:channel', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	const channelParam = c.req.param('channel');
	if (!isChatChannel(channelParam)) return err(c, 'NOT_FOUND', 'unknown channel', 404);
	const channel: ChatChannel = channelParam;
	await c
		.get('db')
		.query(
			`UPDATE chat_channel_configs SET enabled = false, updated_at = now() WHERE channel = $1`,
			[channel],
		);
	const adapter = c.get('chatChannelRegistry')?.get(channel);
	if (adapter) await adapter.stop().catch((e) => log.error(`failed to stop ${channel}`, e));
	return ok(c, { channel, enabled: false });
});

// --- Identity allowlist ---

chatChannelRoutes.get('/chat/identities', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	const rows = await c.get('db').query(
		`SELECT l.id, l.channel, l.external_user_id, l.external_handle, l.user_id, u.display_name, l.created_at
		 FROM chat_identity_links l JOIN users u ON u.id = l.user_id
		 ORDER BY l.created_at DESC`,
	);
	return ok(c, { identities: rows.rows });
});

chatChannelRoutes.post('/chat/identities', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	const body = await c.req.json<{
		channel?: string;
		external_user_id?: string;
		user_id?: string;
		external_handle?: string;
	}>();
	if (!body.channel || !isChatChannel(body.channel) || body.channel === 'web') {
		return err(c, 'INVALID_REQUEST', 'a valid external channel is required', 400);
	}
	if (!body.external_user_id?.trim() || !body.user_id?.trim()) {
		return err(c, 'INVALID_REQUEST', 'external_user_id and user_id are required', 400);
	}
	const db = c.get('db');
	const user = await db.query(`SELECT 1 FROM users WHERE id = $1`, [body.user_id]);
	if (user.rows.length === 0) return err(c, 'NOT_FOUND', 'user not found', 404);
	try {
		const r = await db.query<{ id: string }>(
			`INSERT INTO chat_identity_links (channel, external_user_id, user_id, external_handle)
			 VALUES ($1, $2, $3, $4) RETURNING id`,
			[body.channel, body.external_user_id.trim(), body.user_id, body.external_handle ?? null],
		);
		return ok(c, { id: r.rows[0].id }, 201);
	} catch {
		return err(c, 'CONFLICT', 'that identity is already linked', 409);
	}
});

chatChannelRoutes.delete('/chat/identities/:id', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	const r = await c
		.get('db')
		.query(`DELETE FROM chat_identity_links WHERE id = $1 RETURNING id`, [c.req.param('id')]);
	if (r.rows.length === 0) return err(c, 'NOT_FOUND', 'identity link not found', 404);
	return ok(c, { deleted: true });
});
