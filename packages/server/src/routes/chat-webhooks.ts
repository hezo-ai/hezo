import { timingSafeEqual } from 'node:crypto';
import { type ChatChannel, isChatChannel } from '@hezo/shared';
import { Hono } from 'hono';
import { trackBackground } from '../lib/background';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { ingestInboundEvent } from '../services/chat-channels';
import { loadChannelConfig } from '../services/chat-channels/types';

const log = logger.child('chat-webhooks');

/**
 * Public inbound webhook surface for external chat channels. Mounted BEFORE the
 * `/api/*` auth middleware — inbound platform requests carry no Hezo bearer token,
 * so each is authenticated by a per-channel shared secret in the URL (and, where
 * the platform supports it, a header the adapter also set at registration time).
 *
 * A single generic route serves every webhook-style channel: it verifies the
 * secret against `chat_channel_configs.webhook_secret`, then hands the raw body to
 * the channel adapter's `parseInbound` and the shared `ingestInboundEvent`. No
 * per-channel route files.
 */
export const chatWebhookRoutes = new Hono<Env>();

/** Constant-time string compare that tolerates unequal lengths without throwing. */
function safeEqual(a: string, b: string): boolean {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ab.length !== bb.length) return false;
	return timingSafeEqual(ab, bb);
}

chatWebhookRoutes.post('/webhooks/chat/:channel/:secret', async (c) => {
	const channelParam = c.req.param('channel');
	if (!isChatChannel(channelParam)) return err(c, 'NOT_FOUND', 'unknown channel', 404);
	const channel: ChatChannel = channelParam;

	const db = c.get('db');
	const registry = c.get('chatChannelRegistry');
	const manager = c.get('chatSessionManager');
	if (!registry || !manager) return err(c, 'UNAVAILABLE', 'chat channels unavailable', 503);

	const adapter = registry.get(channel);
	if (!adapter) return err(c, 'NOT_FOUND', 'channel not configured', 404);

	const config = await loadChannelConfig(
		{ db, masterKeyManager: c.get('masterKeyManager') },
		channel,
	);
	if (!config?.enabled || !config.webhookSecret) {
		return err(c, 'NOT_FOUND', 'channel not enabled', 404);
	}

	// Authenticate: the URL secret must match, and (Telegram) the secret-token
	// header when present. Both are constant-time compared.
	const urlSecret = c.req.param('secret');
	const headerSecret = c.req.header('x-telegram-bot-api-secret-token');
	const urlOk = safeEqual(urlSecret, config.webhookSecret);
	const headerOk = headerSecret ? safeEqual(headerSecret, config.webhookSecret) : true;
	if (!urlOk || !headerOk) return err(c, 'UNAUTHORIZED', 'invalid webhook secret', 401);

	const raw = await c.req.json().catch(() => null);
	const event = raw ? adapter.parseInbound(raw) : null;
	// Ack quickly (platforms retry on non-2xx / slow responses); do the work in the
	// background so a slow CEO reply never times out the webhook.
	if (event) {
		trackBackground(
			ingestInboundEvent({ db, manager }, adapter, event).catch((e) =>
				log.error('inbound chat ingest failed', e),
			),
		);
	} else if (raw && adapter.parseClose) {
		// A thread closed on the platform (e.g. a Telegram topic) closes the mirrored
		// conversation everywhere — close parity in the inbound direction.
		const closed = adapter.parseClose(raw);
		if (closed) {
			trackBackground(
				manager
					.closeConversationByExternalThread(channel, closed.externalThreadId)
					.catch((e) => log.error('inbound thread close failed', e)),
			);
		}
	}
	return ok(c, { received: true });
});
