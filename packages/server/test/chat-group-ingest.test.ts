import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChatChannel, DEFAULT_TEAM_ID, wsRoom } from '@hezo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '../src/crypto/encryption';
import type {
	ChatChannelAdapter,
	InboundGroupMentionEvent,
	ThreadContextMessage,
} from '../src/services/chat-channels';
import { formatGroupContextBlock, ingestGroupMentionEvent } from '../src/services/chat-channels';
import { ChatSessionManager } from '../src/services/chat-session-manager';
import type { ExecLogChunk } from '../src/services/docker';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import { getWorkspacePath } from '../src/services/workspace';
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

/**
 * Docker stub that replies "On it — plan incoming" to every turn exec, capturing
 * each turn's prompt by reading the host-mapped prompt file at exec time. When
 * `gate.hold` is set, the FIRST exec blocks until `gate.release()` fires (proves
 * queue-not-interrupt for coworker turns).
 */
function promptCapturingDocker(dataDir: string, projectId: string) {
	const prompts: string[] = [];
	const gate: { hold: boolean; release: () => void; released: Promise<void>; taken: boolean } = {
		hold: false,
		release: () => undefined,
		released: Promise.resolve(),
		taken: false,
	};
	gate.released = new Promise<void>((resolve) => {
		gate.release = resolve;
	});
	const toHostPath = (containerPath: string) =>
		join(
			getWorkspacePath(dataDir, DEFAULT_TEAM_ID, projectId),
			containerPath.replace(/^\/workspace\//, ''),
		);
	const docker = createStubDocker({
		execCreate: async (_id: string, config: { Env?: string[] }) => {
			const promptEntry = (config.Env ?? []).find((e) => e.startsWith('HEZO_PROMPT_FILE='));
			if (promptEntry) {
				prompts.push(
					readFileSync(toHostPath(promptEntry.slice('HEZO_PROMPT_FILE='.length)), 'utf8'),
				);
			}
			return 'exec-turn';
		},
		execStart: async (_execId: string, opts: ExecOpts = {}) => {
			if (gate.hold && !gate.taken) {
				gate.taken = true;
				await gate.released;
			}
			const onChunk = opts.onChunk ?? (() => undefined);
			await onChunk({ stream: 'stdout', text: assistantText('On it — plan incoming') });
			await onChunk({ stream: 'stdout', text: resultEvent() });
			return { stdout: '', stderr: '' };
		},
	});
	return { docker, prompts, gate };
}

/** Spy hooks standing in for the registry: records reply deliveries and closes. */
function spyHooks() {
	const delivered: Array<{ channel: string; ext: string; content: string }> = [];
	return {
		delivered,
		hooks: {
			deliver: async (channel: string, ext: string, content: string) => {
				delivered.push({ channel, ext, content });
			},
			closeThread: async () => undefined,
		},
	};
}

/** A group-capable Slack-shaped stub adapter feeding canned thread context. */
function stubGroupAdapter(context: ThreadContextMessage[] = []): ChatChannelAdapter {
	return {
		channel: ChatChannel.Slack,
		start: async () => undefined,
		stop: async () => undefined,
		parseInbound: () => null,
		deliver: async () => undefined,
		supportsGroupMode: async () => true,
		fetchThreadContext: async () => context,
	};
}

function mention(overrides: Partial<InboundGroupMentionEvent> = {}): InboundGroupMentionEvent {
	return {
		externalUserId: 'U-FAREZ',
		externalThreadId: 'C42:1721.0001',
		text: 'can you make a plan from our chat?',
		senderDisplayName: 'Farez',
		channelName: '#product',
		isThreadReply: false,
		...overrides,
	};
}

describe('group/coworker ingest path', () => {
	let ctx: ServerTestContext;
	let hqProjectId: string;

	beforeEach(async () => {
		ctx = await createTestContext();
		const key = ctx.masterKeyManager.getKey();
		if (!key) throw new Error('master key unavailable');
		await ctx.db.query(
			`INSERT INTO ai_provider_configs (provider, auth_method, label, encrypted_credential, is_default, status, default_model)
			 VALUES ('anthropic', 'api_key', 'test', $1, true, 'verified', 'claude-sonnet-4-6')`,
			[encrypt('sk-ant-test', key)],
		);
		const proj = await ctx.db.query<{ id: string }>(
			`UPDATE projects SET container_id = 'hq-container', container_status = 'running'
			 WHERE team_id = $1 AND is_internal = true RETURNING id`,
			[DEFAULT_TEAM_ID],
		);
		hqProjectId = proj.rows[0].id;
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
		return { manager, wsManager };
	}

	async function waitForCompleteReplies(conversationId: string, count: number) {
		await vi.waitFor(async () => {
			const r = await ctx.db.query<{ c: number }>(
				`SELECT COUNT(*)::int AS c FROM chat_messages
				 WHERE conversation_id = $1 AND role = 'assistant' AND status = 'complete'`,
				[conversationId],
			);
			expect(r.rows[0].c).toBe(count);
		});
	}

	async function conversationFor(externalThreadId: string) {
		const r = await ctx.db.query<{ id: string; kind: string; title: string | null }>(
			`SELECT id, kind::text AS kind, title FROM chat_conversations
			 WHERE channel = 'slack' AND external_thread_id = $1`,
			[externalThreadId],
		);
		return r.rows[0];
	}

	it('creates a coworker conversation living on its channel thread, listed in the web hub', async () => {
		const { docker } = promptCapturingDocker(ctx.dataDir, hqProjectId);
		const { manager } = makeManager(docker);
		const spy = spyHooks();
		manager.setChannelHooks(spy.hooks);

		await ingestGroupMentionEvent({ db: ctx.db, manager }, stubGroupAdapter(), mention());
		const convo = await conversationFor('C42:1721.0001');
		expect(convo.kind).toBe('coworker');
		expect(convo.title).toBe('#product');
		await waitForCompleteReplies(convo.id, 1);

		// The conversation's home is the Slack thread — its own row is the routing
		// key. The web hub lists it alongside ordinary threads, badged by kind.
		const webId = await manager.createWebConversation('Ops sync');
		const listed = await manager.listConversations({ includeClosed: true });
		const coworkerRow = listed.find((c) => c.id === convo.id);
		expect(coworkerRow?.kind).toBe('coworker');
		expect(coworkerRow?.channel).toBe('slack');
		expect(coworkerRow?.external_thread_id).toBe('C42:1721.0001');
		expect(listed.some((c) => c.id === webId)).toBe(true);
		expect(spy.delivered.every((d) => d.channel === 'slack')).toBe(true);
		await manager.stop();
	});

	it('delivers the reply only to the channel thread while the web view streams it', async () => {
		const { docker } = promptCapturingDocker(ctx.dataDir, hqProjectId);
		const { manager, wsManager } = makeManager(docker);
		const spy = spyHooks();
		manager.setChannelHooks(spy.hooks);
		const broadcast = vi.spyOn(wsManager, 'broadcast');

		await ingestGroupMentionEvent({ db: ctx.db, manager }, stubGroupAdapter(), mention());
		const convo = await conversationFor('C42:1721.0001');
		await waitForCompleteReplies(convo.id, 1);
		await vi.waitFor(() => expect(spy.delivered.length).toBeGreaterThanOrEqual(1));

		// The CEO reply went to the Slack thread; the sender's own message was never
		// echoed back; nothing was delivered anywhere else.
		expect(spy.delivered).toEqual([
			{ channel: 'slack', ext: 'C42:1721.0001', content: 'On it — plan incoming' },
		]);
		// The web view renders every thread live: this coworker turn broadcast to
		// its conversation room (and the global list room) like any other thread.
		const chatRooms = broadcast.mock.calls.filter(
			([room]) => room === wsRoom.chat() || room === wsRoom.chatConversation(convo.id),
		);
		expect(chatRooms.length).toBeGreaterThan(0);
		await manager.stop();
	});

	it('injects fetched channel context into the prompt without persisting it', async () => {
		const { docker, prompts } = promptCapturingDocker(ctx.dataDir, hqProjectId);
		const { manager } = makeManager(docker);
		manager.setChannelHooks(spyHooks().hooks);
		const context: ThreadContextMessage[] = [
			{ sender: 'Alice', text: 'we should ship the beta on Friday', timestamp: '17:20' },
			{ sender: 'Bob', text: 'agreed, pending the auth fix' },
		];

		await ingestGroupMentionEvent({ db: ctx.db, manager }, stubGroupAdapter(context), mention());
		const convo = await conversationFor('C42:1721.0001');
		await waitForCompleteReplies(convo.id, 1);

		const prompt = prompts.find((p) =>
			p.includes('Reply to the latest message that mentioned you'),
		);
		expect(prompt).toBeDefined();
		expect(prompt).toContain('## Channel context');
		expect(prompt).toContain('Alice (17:20): we should ship the beta on Friday');
		expect(prompt).toContain('Bob: agreed, pending the auth fix');
		// Group guide replaces the operator chat guide; no long-term memory block.
		expect(prompt).toContain('# Group Channel Chat');
		expect(prompt).not.toContain('## Long-term memory');

		// The fetched context is ephemeral — never a chat_messages row.
		const rows = await ctx.db.query<{ content: string; author_label: string | null }>(
			`SELECT content, author_label FROM chat_messages WHERE conversation_id = $1 ORDER BY created_at`,
			[convo.id],
		);
		expect(rows.rows).toHaveLength(2);
		expect(rows.rows.some((r) => r.content.includes('ship the beta'))).toBe(false);
		expect(rows.rows[0].author_label).toBe('Farez');
		await manager.stop();
	});

	it('merges inline reply-quote context ahead of fetched history', async () => {
		const { docker, prompts } = promptCapturingDocker(ctx.dataDir, hqProjectId);
		const { manager } = makeManager(docker);
		manager.setChannelHooks(spyHooks().hooks);
		const adapter: ChatChannelAdapter = {
			...stubGroupAdapter([{ sender: 'Alice', text: 'we ship friday' }]),
		};

		await ingestGroupMentionEvent(
			{ db: ctx.db, manager },
			adapter,
			mention({
				text: 'what do you think about this?',
				isThreadReply: true,
				inlineContext: [{ sender: 'Bob', text: 'the auth fix is risky' }],
			}),
		);
		const convo = await conversationFor('C42:1721.0001');
		await waitForCompleteReplies(convo.id, 1);

		const prompt = prompts.find((p) => p.includes('## Channel context'));
		expect(prompt).toBeDefined();
		// Fetched/observed history first, then the quote that rode in with the event.
		const alice = prompt?.indexOf('Alice: we ship friday') ?? -1;
		const bob = prompt?.indexOf('Bob: the auth fix is risky') ?? -1;
		expect(alice).toBeGreaterThanOrEqual(0);
		expect(bob).toBeGreaterThan(alice);
		await manager.stop();
	});

	it('labels transcript lines with sender names on later turns', async () => {
		const { docker, prompts } = promptCapturingDocker(ctx.dataDir, hqProjectId);
		const { manager } = makeManager(docker);
		manager.setChannelHooks(spyHooks().hooks);
		const deps = { db: ctx.db, manager };

		await ingestGroupMentionEvent(deps, stubGroupAdapter(), mention());
		const convo = await conversationFor('C42:1721.0001');
		await waitForCompleteReplies(convo.id, 1);
		await ingestGroupMentionEvent(
			deps,
			stubGroupAdapter(),
			mention({ externalUserId: 'U-BOB', senderDisplayName: 'Bob', text: 'and document it too' }),
		);
		await waitForCompleteReplies(convo.id, 2);

		const second = prompts.filter((p) =>
			p.includes('Reply to the latest message that mentioned you'),
		)[1];
		expect(second).toContain('Farez: can you make a plan from our chat?');
		expect(second).toContain('CEO: On it — plan incoming');
		expect(second).toContain('Bob: and document it too');
		await manager.stop();
	});

	it('queues a second mention behind an in-flight reply instead of interrupting it', async () => {
		const { docker, gate } = promptCapturingDocker(ctx.dataDir, hqProjectId);
		gate.hold = true;
		const { manager } = makeManager(docker);
		const spy = spyHooks();
		manager.setChannelHooks(spy.hooks);
		const deps = { db: ctx.db, manager };

		await ingestGroupMentionEvent(deps, stubGroupAdapter(), mention());
		const convo = await conversationFor('C42:1721.0001');
		// First exec is now blocked streaming; the second mention must queue.
		const second = ingestGroupMentionEvent(
			deps,
			stubGroupAdapter(),
			mention({ externalUserId: 'U-BOB', senderDisplayName: 'Bob', text: 'also loop in QA' }),
		);
		gate.release();
		await second;
		await waitForCompleteReplies(convo.id, 2);

		// Neither reply was interrupted, and both were delivered to the thread.
		const statuses = await ctx.db.query<{ status: string }>(
			`SELECT status::text AS status FROM chat_messages
			 WHERE conversation_id = $1 AND role = 'assistant'`,
			[convo.id],
		);
		expect(statuses.rows.map((r) => r.status)).toEqual(['complete', 'complete']);
		await vi.waitFor(() => expect(spy.delivered).toHaveLength(2));
		await manager.stop();
	});

	it('drops the turn quietly when group mode is not active', async () => {
		const { docker } = promptCapturingDocker(ctx.dataDir, hqProjectId);
		const { manager } = makeManager(docker);
		manager.setChannelHooks(spyHooks().hooks);
		const adapter: ChatChannelAdapter = {
			...stubGroupAdapter(),
			supportsGroupMode: async () => false,
		};

		await ingestGroupMentionEvent({ db: ctx.db, manager }, adapter, mention());
		const convo = await conversationFor('C42:1721.0001');
		expect(convo).toBeUndefined();
		await manager.stop();
	});

	it('formatGroupContextBlock frames the history as ephemeral', () => {
		const block = formatGroupContextBlock(
			[{ sender: 'Alice', text: 'hello', timestamp: '17:20' }],
			mention(),
		);
		expect(block).toContain('## Channel context');
		expect(block).toContain('the #product channel');
		expect(block).toContain('ephemeral');
		expect(block).toContain('Alice (17:20): hello');
	});
});
