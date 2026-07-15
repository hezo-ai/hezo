import { DEFAULT_TEAM_ID } from '@hezo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '../src/crypto/encryption';
import { ChatSessionManager } from '../src/services/chat-session-manager';
import type { ExecLogChunk } from '../src/services/docker';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import { WebSocketManager } from '../src/services/ws';
import { createStubDocker } from './helpers/app';
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

/** Spy hooks standing in for the channel registry; Telegram is the mirrorable channel. */
function spyHooks() {
	const created: Array<{ channel: string; title: string }> = [];
	const closed: Array<{ channel: string; ext: string }> = [];
	const delivered: Array<{ channel: string; ext: string; content: string }> = [];
	let topicSeq = 0;
	return {
		created,
		closed,
		delivered,
		hooks: {
			deliver: async (channel: string, ext: string, content: string) => {
				delivered.push({ channel, ext, content });
			},
			closeThread: async (channel: string, ext: string) => {
				closed.push({ channel, ext });
			},
			createThread: async (channel: string, title: string) => {
				created.push({ channel, title });
				return `-100:${++topicSeq}`;
			},
			mirrorableChannels: async () => ['telegram'] as const,
		},
	};
}

async function seedProviderAndContainer(ctx: ServerTestContext): Promise<void> {
	const key = ctx.masterKeyManager.getKey();
	if (!key) throw new Error('master key unavailable');
	await ctx.db.query(
		`INSERT INTO ai_provider_configs (provider, auth_method, label, encrypted_credential, is_default, status, default_model)
		 VALUES ('anthropic', 'api_key', 'test', $1, true, 'verified', 'claude-sonnet-4-6')`,
		[encrypt('sk-ant-test', key)],
	);
	await ctx.db.query(
		`UPDATE projects SET container_id = 'hq-container', container_status = 'running'
		 WHERE team_id = $1 AND is_internal = true`,
		[DEFAULT_TEAM_ID],
	);
}

function makeManager(ctx: ServerTestContext, docker: ReturnType<typeof createStubDocker>) {
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

async function bindings(ctx: ServerTestContext, conversationId: string) {
	const r = await ctx.db.query<{ channel: string; external_thread_id: string | null }>(
		`SELECT channel::text AS channel, external_thread_id FROM chat_conversation_bindings
		 WHERE conversation_id = $1 ORDER BY channel`,
		[conversationId],
	);
	return r.rows;
}

describe('chat thread mirroring across channels', () => {
	let ctx: ServerTestContext;

	beforeEach(async () => {
		ctx = await createTestContext();
		await seedProviderAndContainer(ctx);
	});
	afterEach(() => destroyTestContext(ctx));

	it('creating a web thread mirrors it into every mirror-capable channel', async () => {
		const spy = spyHooks();
		const manager = makeManager(ctx, replyDocker());
		manager.setChannelHooks(spy.hooks);

		const id = await manager.createWebConversation('Launch prep');

		// The Telegram topic was created and bound; the thread is web+telegram bound.
		expect(spy.created).toEqual([{ channel: 'telegram', title: 'Launch prep' }]);
		expect(await bindings(ctx, id)).toEqual([
			{ channel: 'telegram', external_thread_id: '-100:1' },
			{ channel: 'web', external_thread_id: null },
		]);
		const list = await manager.listConversations();
		expect(list.find((c) => c.id === id)?.channels).toEqual(['telegram', 'web']);
	});

	it('closing a thread closes every external binding', async () => {
		const spy = spyHooks();
		const manager = makeManager(ctx, replyDocker());
		manager.setChannelHooks(spy.hooks);
		const id = await manager.createWebConversation('Launch prep');

		await manager.closeConversation(id);
		expect(spy.closed).toEqual([{ channel: 'telegram', ext: '-100:1' }]);
		expect((await manager.getConversation(id))?.closed_at).not.toBeNull();
	});

	it('a topic closed on the platform closes the mirrored conversation', async () => {
		const spy = spyHooks();
		const manager = makeManager(ctx, replyDocker());
		manager.setChannelHooks(spy.hooks);
		const id = await manager.createWebConversation('Launch prep');

		await manager.closeConversationByExternalThread('telegram', '-100:1');
		expect((await manager.getConversation(id))?.closed_at).not.toBeNull();
	});

	it('fans a web turn out to the Telegram binding — user message + CEO reply', async () => {
		const spy = spyHooks();
		const manager = makeManager(ctx, replyDocker());
		manager.setChannelHooks(spy.hooks);
		const id = await manager.createWebConversation('Launch prep');

		const { assistantMessageId } = await manager.sendTurn({ text: 'ship it?', conversationId: id });
		// Wait for the assistant row to finalize.
		await vi.waitFor(async () => {
			const r = await ctx.db.query<{ status: string }>(
				`SELECT status::text AS status FROM chat_messages WHERE id = $1`,
				[assistantMessageId],
			);
			expect(r.rows[0]?.status).toBe('complete');
		});
		await vi.waitFor(() => expect(spy.delivered.length).toBeGreaterThanOrEqual(2));

		const toTelegram = spy.delivered.filter((d) => d.channel === 'telegram' && d.ext === '-100:1');
		// The operator's message mirrored (labelled) + the CEO reply.
		expect(toTelegram.some((d) => d.content.includes('ship it?'))).toBe(true);
		expect(toTelegram.some((d) => d.content.includes('Hi from the CEO'))).toBe(true);
		await manager.stop();
	});

	it('a Telegram-origin message is NOT echoed back to its own topic', async () => {
		const spy = spyHooks();
		const manager = makeManager(ctx, replyDocker());
		manager.setChannelHooks(spy.hooks);

		// Inbound Telegram message on a brand-new topic → creates the conversation.
		const { conversationId, assistantMessageId } = await manager.sendTurn({
			text: 'hello from telegram',
			channel: 'telegram',
			externalThreadId: '-100:99',
			authorUserId: null,
		});
		await vi.waitFor(async () => {
			const r = await ctx.db.query<{ status: string }>(
				`SELECT status::text AS status FROM chat_messages WHERE id = $1`,
				[assistantMessageId],
			);
			expect(r.rows[0]?.status).toBe('complete');
		});
		// It got a web binding (reachable from the switcher).
		const chans = (await bindings(ctx, conversationId)).map((b) => b.channel);
		expect(chans).toContain('web');
		expect(chans).toContain('telegram');

		await vi.waitFor(() => expect(spy.delivered.length).toBeGreaterThanOrEqual(1));
		// The user's own inbound text is never delivered back to its origin topic.
		const echo = spy.delivered.filter(
			(d) => d.ext === '-100:99' && d.content.includes('hello from telegram'),
		);
		expect(echo).toHaveLength(0);
		// The CEO reply DOES land in the origin topic.
		expect(
			spy.delivered.some((d) => d.ext === '-100:99' && d.content.includes('Hi from the CEO')),
		).toBe(true);
		await manager.stop();
	});
});
