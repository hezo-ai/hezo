import { ChatChannel, DEFAULT_TEAM_ID } from '@hezo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '../src/crypto/encryption';
import { ChatSessionManager } from '../src/services/chat-session-manager';
import type { ExecLogChunk } from '../src/services/docker';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import { WebSocketManager } from '../src/services/ws';
import { createStubDocker, seedCeoWebConversation, seedProjectContainer } from './helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

const claudeLine = (obj: unknown) => `${JSON.stringify(obj)}\n`;
const assistantText = (text: string) =>
	claudeLine({
		type: 'assistant',
		message: { role: 'assistant', content: [{ type: 'text', text }] },
	});
const resultEvent = () =>
	claudeLine({ type: 'result', usage: { input_tokens: 5, output_tokens: 3 } });

type ExecOpts = { signal?: AbortSignal; onChunk?: (c: ExecLogChunk) => void | Promise<void> };

/** Docker stub that replies "Hi from the CEO" to a chat-turn exec; aux execs are no-ops. */
function replyDocker() {
	return createStubDocker({
		execCreate: async (_id: string, config: { Env?: string[] }) => {
			const hasPrompt = (config.Env ?? []).some((e) => e.startsWith('HEZO_PROMPT_FILE='));
			return hasPrompt ? 'turn' : 'aux';
		},
		execStart: async (execId: string, opts: ExecOpts = {}) => {
			if (execId !== 'turn') return { stdout: '', stderr: '' };
			const onChunk = opts.onChunk ?? (() => undefined);
			await onChunk({ stream: 'stdout', text: assistantText('Hi from the CEO') });
			await onChunk({ stream: 'stdout', text: resultEvent() });
			return { stdout: '', stderr: '' };
		},
	});
}

/** Spy hooks standing in for the registry: records deliveries and closes. */
function spyHooks() {
	const delivered: Array<{ channel: string; ext: string; content: string }> = [];
	const closed: Array<{ channel: string; ext: string }> = [];
	return {
		delivered,
		closed,
		hooks: {
			deliver: async (channel: string, ext: string, content: string) => {
				delivered.push({ channel, ext, content });
			},
			closeThread: async (channel: string, ext: string) => {
				closed.push({ channel, ext });
			},
		},
	};
}

async function waitForComplete(ctx: ServerTestContext, assistantMessageId: string) {
	await vi.waitFor(async () => {
		const r = await ctx.db.query<{ status: string }>(
			`SELECT status::text AS status FROM chat_messages WHERE id = $1`,
			[assistantMessageId],
		);
		expect(r.rows[0]?.status).toBe('complete');
	});
}

// The de-mirrored thread model: every conversation lives on exactly one surface
// (its row's channel + external_thread_id IS the routing key — no bindings, no
// fan-out), the web view lists every thread, and each turn's reply is delivered
// to the surface the turn came from.
describe('per-surface chat thread routing', () => {
	let ctx: ServerTestContext;

	beforeEach(async () => {
		ctx = await createTestContext();
		const key = ctx.masterKeyManager.getKey();
		if (!key) throw new Error('master key unavailable');
		await ctx.db.query(
			`INSERT INTO ai_provider_configs (provider, auth_method, label, encrypted_credential, is_default, status, default_model)
			 VALUES ('anthropic', 'api_key', 'test', $1, true, 'verified', 'claude-sonnet-4-6')`,
			[encrypt('sk-ant-test', key)],
		);
		const hq = await ctx.db.query<{ id: string }>(
			`SELECT id FROM projects WHERE team_id = $1 AND is_internal = true`,
			[DEFAULT_TEAM_ID],
		);
		await seedProjectContainer(ctx.db, hq.rows[0].id, 'hq-container');
	});
	afterEach(() => destroyTestContext(ctx));

	function makeManager(docker: ReturnType<typeof createStubDocker>) {
		const wsManager = new WebSocketManager();
		const logs = new LogStreamBroker();
		logs.setWsManager(wsManager);
		const manager = new ChatSessionManager({
			db: ctx.db,
			docker,
			masterKeyManager: ctx.masterKeyManager,
			serverPort: 0,
			dataDir: ctx.dataDir,
			wsManager,
			logs,
		});
		return manager;
	}

	it('a web thread exists nowhere else — creating it touches no platform', async () => {
		const spy = spyHooks();
		const manager = makeManager(replyDocker());
		manager.setChannelHooks(spy.hooks);

		const id = await seedCeoWebConversation(ctx.db, 'Launch prep');
		const listed = await manager.listConversations();
		const row = listed.find((c) => c.id === id);
		expect(row?.channel).toBe('web');
		expect(row?.kind).toBe('assistant');
		expect(spy.delivered).toEqual([]);
		expect(spy.closed).toEqual([]);
	});

	it('a telegram turn is answered in telegram; nothing is echoed or fanned out', async () => {
		const spy = spyHooks();
		const manager = makeManager(replyDocker());
		manager.setChannelHooks(spy.hooks);

		const { conversationId, assistantMessageId } = await manager.sendTurn({
			text: 'hello from telegram',
			channel: ChatChannel.Telegram,
			externalThreadId: '999',
			authorUserId: null,
		});
		await waitForComplete(ctx, assistantMessageId);

		// The thread lives on telegram and is listed in the web hub.
		const listed = await manager.listConversations();
		const row = listed.find((c) => c.id === conversationId);
		expect(row?.channel).toBe('telegram');
		expect(row?.external_thread_id).toBe('999');
		expect(row?.kind).toBe('assistant');

		await vi.waitFor(() => expect(spy.delivered.length).toBeGreaterThanOrEqual(1));
		// Exactly one delivery: the CEO reply back to the asking surface. The
		// user's own message is never re-posted anywhere.
		expect(spy.delivered).toEqual([
			{ channel: 'telegram', ext: '999', content: 'Hi from the CEO' },
		]);
	});

	it('a web turn into a telegram-origin thread is answered on web only', async () => {
		const spy = spyHooks();
		const manager = makeManager(replyDocker());
		manager.setChannelHooks(spy.hooks);

		const first = await manager.sendTurn({
			text: 'hello from telegram',
			channel: ChatChannel.Telegram,
			externalThreadId: '999',
			authorUserId: null,
		});
		await waitForComplete(ctx, first.assistantMessageId);
		await vi.waitFor(() => expect(spy.delivered).toHaveLength(1));

		// Reply-where-asked: the web-sent turn streams to web; telegram gets nothing.
		const second = await manager.sendTurn({
			text: 'follow-up from the web view',
			conversationId: first.conversationId,
			channel: ChatChannel.Web,
			authorUserId: null,
		});
		expect(second.conversationId).toBe(first.conversationId);
		await waitForComplete(ctx, second.assistantMessageId);
		await new Promise((r) => setTimeout(r, 50));
		expect(spy.delivered).toHaveLength(1);

		// Both turns share the stored conversation; provenance is per-message.
		const channels = await ctx.db.query<{ channel: string; role: string }>(
			`SELECT channel::text AS channel, role::text AS role FROM chat_messages
			 WHERE conversation_id = $1 ORDER BY created_at`,
			[first.conversationId],
		);
		expect(channels.rows.map((r) => r.channel)).toEqual(['telegram', 'telegram', 'web', 'web']);
	});

	it('closing an external thread closes its platform surface; the next message starts fresh', async () => {
		const spy = spyHooks();
		const manager = makeManager(replyDocker());
		manager.setChannelHooks(spy.hooks);

		const first = await manager.sendTurn({
			text: 'hi',
			channel: ChatChannel.Telegram,
			externalThreadId: '-100:7',
			authorUserId: null,
		});
		await waitForComplete(ctx, first.assistantMessageId);
		await manager.closeConversation(first.conversationId);
		expect(spy.closed).toEqual([{ channel: 'telegram', ext: '-100:7' }]);
		expect((await manager.getConversation(first.conversationId))?.closed_at).not.toBeNull();

		// Same external thread, new inbound → a brand-new conversation.
		const second = await manager.sendTurn({
			text: 'hi again',
			channel: ChatChannel.Telegram,
			externalThreadId: '-100:7',
			authorUserId: null,
		});
		expect(second.conversationId).not.toBe(first.conversationId);
		await waitForComplete(ctx, second.assistantMessageId);
		await manager.stop();
	});

	it('a topic closed on the platform closes the conversation here', async () => {
		const spy = spyHooks();
		const manager = makeManager(replyDocker());
		manager.setChannelHooks(spy.hooks);

		const { conversationId, assistantMessageId } = await manager.sendTurn({
			text: 'hi',
			channel: ChatChannel.Telegram,
			externalThreadId: '-100:9',
			authorUserId: null,
		});
		await waitForComplete(ctx, assistantMessageId);
		await manager.closeConversationByExternalThread(ChatChannel.Telegram, '-100:9');
		expect((await manager.getConversation(conversationId))?.closed_at).not.toBeNull();
		await manager.stop();
	});
});
