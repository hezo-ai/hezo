import { ChatChannel } from '@hezo/shared';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { PgliteDb } from '../src/db/drivers/pglite';
import type { Env } from '../src/lib/types';
import { chatWebhookRoutes } from '../src/routes/chat-webhooks';
import { ChatChannelRegistry } from '../src/services/chat-channels/registry';
import type {
	ChatChannelAdapter,
	InboundChatEvent,
	OutboundReply,
} from '../src/services/chat-channels/types';
import type { ChatSessionManager } from '../src/services/chat-session-manager';
import { createTestDbWithMigrations } from './helpers/db';

const SECRET = 'webhook-secret-123';

/** Fake adapter: real Telegram-shaped parse, but deliver/promptToLink are spies. */
function makeAdapter() {
	const promptToLink = vi.fn(async (_e: InboundChatEvent) => undefined);
	const deliver = vi.fn(async (_r: OutboundReply) => undefined);
	const adapter: ChatChannelAdapter = {
		channel: ChatChannel.Telegram,
		start: async () => undefined,
		stop: async () => undefined,
		parseInbound: (raw: unknown) => {
			const m = (
				raw as { message?: { text?: string; from?: { id?: number }; chat?: { id?: number } } }
			)?.message;
			if (!m?.text || !m.from?.id || !m.chat?.id) return null;
			return {
				externalUserId: String(m.from.id),
				externalThreadId: String(m.chat.id),
				text: m.text,
			};
		},
		deliver,
		promptToLink,
	};
	return { adapter, promptToLink, deliver };
}

describe('POST /webhooks/chat/:channel/:secret', () => {
	let db: PgliteDb;
	let app: Hono<Env>;
	let sendTurn: ReturnType<typeof vi.fn>;
	let promptToLink: ReturnType<typeof vi.fn>;
	let userId: string;

	beforeAll(async () => {
		db = await createTestDbWithMigrations();
		await db.query(
			`INSERT INTO chat_channel_configs (channel, enabled, bot_token_secret, webhook_secret)
			 VALUES ('telegram', true, 'TELEGRAM_BOT_TOKEN', $1)`,
			[SECRET],
		);
		const u = await db.query<{ id: string }>(
			`INSERT INTO users (display_name) VALUES ('Op') RETURNING id`,
		);
		userId = u.rows[0].id;
		await db.query(
			`INSERT INTO chat_identity_links (channel, external_user_id, user_id) VALUES ('telegram', '42', $1)`,
			[userId],
		);
	});
	afterAll(() => db.close());

	beforeEach(() => {
		const built = makeAdapter();
		promptToLink = built.promptToLink;
		const registry = new ChatChannelRegistry();
		registry.register(built.adapter);
		sendTurn = vi.fn(async () => ({
			userMessageId: 'u',
			assistantMessageId: 'a',
			conversationId: 'c',
		}));
		const manager = { sendTurn } as unknown as ChatSessionManager;

		app = new Hono<Env>();
		app.use('*', async (c, next) => {
			c.set('db', db);
			// Complete enough to satisfy every method the webhook path can reach: these
			// rows carry a legacy plaintext webhook_secret, so no decrypt is needed.
			c.set('masterKeyManager', { getKey: () => null } as unknown as MasterKeyManager);
			c.set('chatSessionManager', manager);
			c.set('chatChannelRegistry', registry);
			await next();
		});
		app.route('/', chatWebhookRoutes);
	});

	const post = (secret: string, body: unknown, headers: Record<string, string> = {}) =>
		app.request(`/webhooks/chat/telegram/${secret}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...headers },
			body: JSON.stringify(body),
		});

	const linkedMessage = { message: { text: 'hello', from: { id: 42 }, chat: { id: 999 } } };

	it('routes a linked sender’s message to the CEO chat', async () => {
		const res = await post(SECRET, linkedMessage);
		expect(res.status).toBe(200);
		// ingest runs in the background; give the microtask/tracked promise a tick.
		await vi.waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(1));
		expect(sendTurn.mock.calls[0][0]).toMatchObject({
			text: 'hello',
			channel: 'telegram',
			externalThreadId: '999',
			authorUserId: userId,
		});
	});

	it('rejects a wrong URL secret with 401 and never ingests', async () => {
		const res = await post('wrong-secret', linkedMessage);
		expect(res.status).toBe(401);
		await new Promise((r) => setTimeout(r, 20));
		expect(sendTurn).not.toHaveBeenCalled();
	});

	it('rejects a mismatched secret-token header', async () => {
		const res = await post(SECRET, linkedMessage, {
			'x-telegram-bot-api-secret-token': 'nope',
		});
		expect(res.status).toBe(401);
	});

	it('accepts a matching secret-token header', async () => {
		const res = await post(SECRET, linkedMessage, {
			'x-telegram-bot-api-secret-token': SECRET,
		});
		expect(res.status).toBe(200);
	});

	it('ignores an unlinked sender and prompts them to link', async () => {
		const res = await post(SECRET, {
			message: { text: 'hi', from: { id: 8888 }, chat: { id: 1 } },
		});
		expect(res.status).toBe(200);
		await vi.waitFor(() => expect(promptToLink).toHaveBeenCalledTimes(1));
		expect(sendTurn).not.toHaveBeenCalled();
	});

	it('returns 404 for an unknown channel', async () => {
		const res = await app.request(`/webhooks/chat/nope/${SECRET}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}',
		});
		expect(res.status).toBe(404);
	});
});

describe('group dispatch + observation on the generic webhook route', () => {
	let db: PgliteDb;
	let app: Hono<Env>;
	let sendTurn: ReturnType<typeof vi.fn>;
	let observed: unknown[];

	beforeAll(async () => {
		db = await createTestDbWithMigrations();
		await db.query(
			`INSERT INTO chat_channel_configs (channel, enabled, bot_token_secret, webhook_secret)
			 VALUES ('telegram', true, 'TELEGRAM_BOT_TOKEN', $1)`,
			[SECRET],
		);
	});
	afterAll(() => db.close());

	beforeEach(() => {
		observed = [];
		// Group-capable fake: mentions carry '@bot'; everything else is unclaimed
		// group chatter handed to observeMessage.
		const adapter: ChatChannelAdapter = {
			channel: ChatChannel.Telegram,
			start: async () => undefined,
			stop: async () => undefined,
			parseInbound: () => null,
			deliver: async () => undefined,
			supportsGroupMode: async () => true,
			parseGroupMention: (raw: unknown) => {
				const m = (raw as { message?: { text?: string; from?: { id?: number } } })?.message;
				if (!m?.text?.includes('@bot')) return null;
				return {
					externalUserId: String(m.from?.id ?? 0),
					externalThreadId: '-555',
					text: m.text.replace('@bot', '').trim(),
					senderDisplayName: 'Farez',
					isThreadReply: false,
				};
			},
			fetchThreadContext: async () => [],
			observeMessage: async (raw: unknown) => {
				observed.push(raw);
			},
		};
		const registry = new ChatChannelRegistry();
		registry.register(adapter);
		sendTurn = vi.fn(async () => ({
			userMessageId: 'u',
			assistantMessageId: 'a',
			conversationId: 'c',
		}));
		const manager = { sendTurn } as unknown as ChatSessionManager;

		app = new Hono<Env>();
		app.use('*', async (c, next) => {
			c.set('db', db);
			// Complete enough to satisfy every method the webhook path can reach: these
			// rows carry a legacy plaintext webhook_secret, so no decrypt is needed.
			c.set('masterKeyManager', { getKey: () => null } as unknown as MasterKeyManager);
			c.set('chatSessionManager', manager);
			c.set('chatChannelRegistry', registry);
			await next();
		});
		app.route('/', chatWebhookRoutes);
	});

	const post = (body: unknown) =>
		app.request(`/webhooks/chat/telegram/${SECRET}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});

	it('routes a group mention to the coworker path (kind + no allowlist gate)', async () => {
		const res = await post({ message: { text: '@bot make a plan', from: { id: 42 } } });
		expect(res.status).toBe(200);
		await vi.waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(1));
		expect(sendTurn.mock.calls[0][0]).toMatchObject({
			text: 'make a plan',
			channel: 'telegram',
			externalThreadId: '-555',
			kind: 'coworker',
			authorLabel: 'Farez',
			// Unlinked group senders are served — the invite is the authorization.
			authorUserId: null,
		});
		expect(observed).toHaveLength(0);
	});

	it('hands unclaimed group chatter to the observed-message buffer', async () => {
		const res = await post({ message: { text: 'no mention here', from: { id: 42 } } });
		expect(res.status).toBe(200);
		await vi.waitFor(() => expect(observed).toHaveLength(1));
		expect(sendTurn).not.toHaveBeenCalled();
	});
});
