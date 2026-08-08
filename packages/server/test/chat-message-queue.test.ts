import { readFileSync } from 'node:fs';
import { ChatChannel, DEFAULT_TEAM_ID } from '@hezo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '../src/crypto/encryption';
import { getHostPromptPath } from '../src/services/agent-runner';
import { ChatSessionManager } from '../src/services/chat-session-manager';
import type { ExecLogChunk } from '../src/services/docker';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import { WebSocketManager } from '../src/services/ws';
import { buildApp } from '../src/startup';
import { authHeader, createStubDocker, seedProjectContainer } from './helpers/app';
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
 * A reply exec, as opposed to the auto-title run that streams alongside it off
 * its own `-title` prompt file (see `turnPrompt`'s `slot`).
 */
function replyPromptFile(env: string[] | undefined): string | null {
	const prompt = (env ?? []).find((e) => e.startsWith('HEZO_PROMPT_FILE='));
	if (!prompt || prompt.endsWith('-title.txt')) return null;
	return prompt.slice('HEZO_PROMPT_FILE='.length);
}

/**
 * Docker stub that answers each chat-turn exec and records the prompt file each
 * reply was pointed at, so a test can count how many reply turns actually ran.
 */
function replyDocker(turns: string[]) {
	return createStubDocker({
		execCreate: async (_id: string, config: { Env?: string[] }) => {
			const prompt = replyPromptFile(config.Env);
			if (!prompt) return 'aux';
			turns.push(prompt);
			return 'turn';
		},
		execStart: async (execId: string, opts: ExecOpts = {}) => {
			if (execId !== 'turn') return { stdout: '', stderr: '' };
			const onChunk = opts.onChunk ?? (() => undefined);
			await onChunk({ stream: 'stdout', text: assistantText('On it.') });
			await onChunk({ stream: 'stdout', text: resultEvent() });
			return { stdout: '', stderr: '' };
		},
	});
}

// The web chatbox parks messages typed while a reply streams and flushes the whole
// queue when the thread goes idle. It flushes as ONE turn carrying several user
// messages — N separate turns would produce N replies, the first of which answers
// stale context. These cover the server half of that: the batch shape on
// `sendTurn`, its route, and the single reply it yields.
describe('chat message queue flush (batched user messages)', () => {
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
		return new ChatSessionManager({
			db: ctx.db,
			docker,
			masterKeyManager: ctx.masterKeyManager,
			serverPort: 0,
			dataDir: ctx.dataDir,
			wsManager,
			logs,
		});
	}

	async function waitForComplete(assistantMessageId: string) {
		await vi.waitFor(async () => {
			const r = await ctx.db.query<{ status: string }>(
				`SELECT status::text AS status FROM chat_messages WHERE id = $1`,
				[assistantMessageId],
			);
			expect(r.rows[0]?.status).toBe('complete');
		});
	}

	async function userMessages(conversationId: string) {
		const r = await ctx.db.query<{ content: string }>(
			`SELECT content FROM chat_messages
			 WHERE conversation_id = $1 AND role = 'user' ORDER BY created_at ASC`,
			[conversationId],
		);
		return r.rows.map((row) => row.content);
	}

	it('posts each queued message as its own row, then one reply for all of them', async () => {
		const turns: string[] = [];
		const manager = makeManager(replyDocker(turns));

		const result = await manager.sendTurn({
			text: 'first',
			channel: ChatChannel.Web,
			messages: [
				{ text: 'what is blocking the release?' },
				{ text: 'also check the Coach backlog' },
				{ text: 'and who owns the 041 test?' },
			],
		});
		await waitForComplete(result.assistantMessageId);

		// Three user bubbles, in the order they were queued…
		expect(await userMessages(result.conversationId)).toEqual([
			'what is blocking the release?',
			'also check the Coach backlog',
			'and who owns the 041 test?',
		]);
		expect(result.userMessageIds).toHaveLength(3);
		// …and exactly one assistant row, from exactly one exec.
		const assistants = await ctx.db.query<{ count: number }>(
			`SELECT COUNT(*)::int AS count FROM chat_messages
			 WHERE conversation_id = $1 AND role = 'assistant'`,
			[result.conversationId],
		);
		expect(assistants.rows[0].count).toBe(1);
		expect(turns).toHaveLength(1);
	});

	it('composes every queued message into the single turn prompt', async () => {
		// The prompt file is written before the exec and deleted after it, so read it
		// mid-exec — this is the assertion that the CEO actually sees all of the
		// queued messages rather than only the first.
		let promptBody = '';
		const docker = createStubDocker({
			execCreate: async (_id: string, config: { Env?: string[] }) => {
				const containerPath = replyPromptFile(config.Env);
				if (!containerPath) return 'aux';
				const key =
					containerPath
						.split('/')
						.pop()
						?.replace(/\.txt$/, '') ?? '';
				const hq = await ctx.db.query<{ id: string }>(
					`SELECT id FROM projects WHERE team_id = $1 AND is_internal = true`,
					[DEFAULT_TEAM_ID],
				);
				promptBody = readFileSync(
					getHostPromptPath(ctx.dataDir, DEFAULT_TEAM_ID, hq.rows[0].id, key),
					'utf8',
				);
				return 'turn';
			},
			execStart: async (execId: string, opts: ExecOpts = {}) => {
				if (execId !== 'turn') return { stdout: '', stderr: '' };
				const onChunk = opts.onChunk ?? (() => undefined);
				await onChunk({ stream: 'stdout', text: assistantText('Ack.') });
				await onChunk({ stream: 'stdout', text: resultEvent() });
				return { stdout: '', stderr: '' };
			},
		});
		const manager = makeManager(docker);

		const result = await manager.sendTurn({
			text: 'q1',
			channel: ChatChannel.Web,
			messages: [{ text: 'first question' }, { text: 'second question' }],
		});
		await waitForComplete(result.assistantMessageId);

		expect(promptBody).toContain('first question');
		expect(promptBody).toContain('second question');
	});

	it('falls back to the single-message shape when no batch is given', async () => {
		const turns: string[] = [];
		const manager = makeManager(replyDocker(turns));

		const result = await manager.sendTurn({ text: 'just the one', channel: ChatChannel.Web });
		await waitForComplete(result.assistantMessageId);

		expect(await userMessages(result.conversationId)).toEqual(['just the one']);
		expect(result.userMessageIds).toEqual([result.userMessageId]);
	});

	it('accepts a batch over POST /api/chat/messages and rejects a malformed one', async () => {
		const turns: string[] = [];
		const docker = replyDocker(turns);
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
		const app = buildApp(
			ctx.db,
			ctx.masterKeyManager,
			{ dataDir: ctx.dataDir, webUrl: '' },
			docker,
			wsManager,
			undefined,
			logs,
			null,
			null,
			undefined,
			undefined,
			manager,
		);
		const headers = { ...authHeader(ctx.token), 'content-type': 'application/json' };

		const res = await app.request('/api/chat/messages', {
			method: 'POST',
			headers,
			body: JSON.stringify({ messages: [{ text: 'one' }, { text: 'two' }] }),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			data: { user_message_ids: string[]; assistant_message_id: string; conversation_id: string };
		};
		expect(body.data.user_message_ids).toHaveLength(2);
		await waitForComplete(body.data.assistant_message_id);
		expect(await userMessages(body.data.conversation_id)).toEqual(['one', 'two']);

		// An entry with neither text nor an attachment is not sendable.
		const bad = await app.request('/api/chat/messages', {
			method: 'POST',
			headers,
			body: JSON.stringify({ messages: [{ text: 'ok' }, { text: '   ' }] }),
		});
		expect(bad.status).toBe(400);

		await manager.stop();
	});
});
