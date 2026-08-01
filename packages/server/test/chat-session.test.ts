import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	AuthType,
	ChatMessageStatus,
	ChatSessionStatus,
	DEFAULT_TEAM_ID,
	wsRoom,
} from '@hezo/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { encrypt } from '../src/crypto/encryption';
import { signChatSessionJwt, verifyToken } from '../src/middleware/auth';
import { ChatSessionManager } from '../src/services/chat-session-manager';
import type { ExecLogChunk } from '../src/services/docker';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import { getWorkspacePath } from '../src/services/workspace';
import type { WsSocket } from '../src/services/ws';
import { WebSocketManager } from '../src/services/ws';
import { createStubDocker } from './helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

const claudeLine = (obj: unknown) => `${JSON.stringify(obj)}\n`;
const assistantText = (text: string) =>
	claudeLine({
		type: 'assistant',
		message: { role: 'assistant', content: [{ type: 'text', text }] },
	});
const resultEvent = (input: number, output: number, costUsd: number) =>
	claudeLine({
		type: 'result',
		usage: { input_tokens: input, output_tokens: output },
		total_cost_usd: costUsd,
	});

// Reply turns are interleaved with background auto-title / compaction execs (each with
// its own prompt), so filter captured prompts to the actual operator-reply turns.
const isReplyPrompt = (p: string) => p.includes('Reply to the latest operator message as the CEO.');

async function poll(fn: () => Promise<boolean>, timeoutMs = 4000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await fn()) return;
		await new Promise((r) => setTimeout(r, 15));
	}
	throw new Error('poll timed out');
}

interface ChatDocker {
	docker: ReturnType<typeof createStubDocker>;
	prompts: string[];
	scenario: { mode: 'reply' | 'block'; entered: boolean };
}

/**
 * Docker stub whose execStart streams scripted Claude stream-json frames. In
 * `reply` mode it emits one assistant text block + a result, then exits. In
 * `block` mode it emits a partial then waits until the AbortSignal fires
 * (mirrors a turn interrupted by a newer message). Captures each turn's prompt
 * by reading the host-mapped prompt file at exec time.
 */
function makeChatDocker(dataDir: string, projectId: string): ChatDocker {
	const prompts: string[] = [];
	const scenario = { mode: 'reply' as 'reply' | 'block', entered: false };
	const toHostPath = (containerPath: string) =>
		join(
			getWorkspacePath(dataDir, DEFAULT_TEAM_ID, projectId),
			containerPath.replace(/^\/workspace\//, ''),
		);

	const docker = createStubDocker({
		execCreate: async (_id: string, config: { Env?: string[] }) => {
			const promptEntry = (config.Env ?? []).find((e) => e.startsWith('HEZO_PROMPT_FILE='));
			if (promptEntry) {
				const containerPath = promptEntry.slice('HEZO_PROMPT_FILE='.length);
				prompts.push(readFileSync(toHostPath(containerPath), 'utf8'));
			}
			return 'exec-1';
		},
		execStart: async (
			_execId: string,
			opts: { signal?: AbortSignal; onChunk?: (c: ExecLogChunk) => void | Promise<void> },
		) => {
			scenario.entered = true;
			const onChunk = opts.onChunk ?? (() => undefined);
			if (scenario.mode === 'reply') {
				await onChunk({ stream: 'stdout', text: assistantText('Hi there') });
				await onChunk({ stream: 'stdout', text: resultEvent(10, 5, 0.02) });
				return { stdout: '', stderr: '' };
			}
			await onChunk({ stream: 'stdout', text: assistantText('thinking') });
			await new Promise<void>((_resolve, reject) => {
				opts.signal?.addEventListener('abort', () =>
					reject(new DOMException('Aborted', 'AbortError')),
				);
			});
			return { stdout: '', stderr: '' };
		},
	});
	return { docker, prompts, scenario };
}

/**
 * Docker stub that routes by prompt type (title exec vs reply exec), so a test can
 * hold the reply open while the parallel auto-title exec still returns a title. The
 * reply streams a partial then blocks until aborted; the title exec streams
 * `titleText` and exits. Used to prove titling doesn't wait for the reply to settle.
 */
function makeTitleRoutingDocker(
	dataDir: string,
	projectId: string,
	titleText: string,
): { docker: ReturnType<typeof createStubDocker>; prompts: string[] } {
	const prompts: string[] = [];
	const toHostPath = (containerPath: string) =>
		join(
			getWorkspacePath(dataDir, DEFAULT_TEAM_ID, projectId),
			containerPath.replace(/^\/workspace\//, ''),
		);
	const docker = createStubDocker({
		execCreate: async (_id: string, config: { Env?: string[] }) => {
			const promptEntry = (config.Env ?? []).find((e) => e.startsWith('HEZO_PROMPT_FILE='));
			if (!promptEntry) return 'exec-reply';
			const prompt = readFileSync(
				toHostPath(promptEntry.slice('HEZO_PROMPT_FILE='.length)),
				'utf8',
			);
			prompts.push(prompt);
			// The title prompt is buildTitlePrompt's header; everything else is a reply.
			return prompt.includes('# Name this conversation') ? 'exec-title' : 'exec-reply';
		},
		execStart: async (
			execId: string,
			opts: { signal?: AbortSignal; onChunk?: (c: ExecLogChunk) => void | Promise<void> },
		) => {
			const onChunk = opts.onChunk ?? (() => undefined);
			if (execId === 'exec-title') {
				await onChunk({ stream: 'stdout', text: assistantText(titleText) });
				return { stdout: '', stderr: '' };
			}
			// Reply: emit a partial, then block until the turn is interrupted/torn down.
			await onChunk({ stream: 'stdout', text: assistantText('working on it') });
			await new Promise<void>((_resolve, reject) => {
				opts.signal?.addEventListener('abort', () =>
					reject(new DOMException('Aborted', 'AbortError')),
				);
			});
			return { stdout: '', stderr: '' };
		},
	});
	return { docker, prompts };
}

function captureCeoRoom(wsManager: WebSocketManager): { events: Array<Record<string, unknown>> } {
	const events: Array<Record<string, unknown>> = [];
	const socket: WsSocket = {
		data: { auth: { type: AuthType.Admin, isSuperuser: true }, rooms: new Set() },
		send: (msg: string) => events.push(JSON.parse(msg)),
	};
	wsManager.subscribe(socket, wsRoom.chat());
	return { events };
}

async function seedProviderAndContainer(ctx: ServerTestContext): Promise<string> {
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
	// The pool has to say the same thing as the column, because the chat resolves
	// its container through the pool now. Re-seeding only the column left members
	// behind from earlier tests - including one a provisioning spec created - and
	// the ladder handed the next test that container instead of `hq-container`,
	// which is the seeded premise every spec in this file is written against.
	await ctx.db.query('DELETE FROM container_pool_members WHERE project_id = $1', [proj.rows[0].id]);
	return proj.rows[0].id;
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
	return { manager, wsManager };
}

describe('ChatSessionManager', () => {
	let ctx: ServerTestContext;
	let projectId: string;

	beforeAll(async () => {
		ctx = await createTestContext();
	});
	afterAll(async () => {
		await destroyTestContext(ctx);
	});
	beforeEach(async () => {
		await ctx.db.query('DELETE FROM chat_messages');
		await ctx.db.query('DELETE FROM chat_sessions');
		await ctx.db.query('DELETE FROM chat_conversations');
		await ctx.db.query('DELETE FROM ai_provider_configs');
		projectId = await seedProviderAndContainer(ctx);
	});

	test('streams a reply and finalizes the assistant message with usage', async () => {
		const { docker } = makeChatDocker(ctx.dataDir, projectId);
		const { manager, wsManager } = makeManager(ctx, docker);
		const captured = captureCeoRoom(wsManager);

		const { userMessageId, assistantMessageId } = await manager.sendTurn({ text: 'Hello CEO' });
		expect(userMessageId).toBeTruthy();

		await poll(async () => {
			const r = await ctx.db.query<{ status: string }>(
				'SELECT status FROM chat_messages WHERE id = $1',
				[assistantMessageId],
			);
			return r.rows[0]?.status === ChatMessageStatus.Complete;
		});

		const asst = await ctx.db.query<{
			content: string;
			input_tokens: number;
			output_tokens: number;
		}>('SELECT content, input_tokens, output_tokens FROM chat_messages WHERE id = $1', [
			assistantMessageId,
		]);
		expect(asst.rows[0].content).toBe('Hi there');
		expect(Number(asst.rows[0].input_tokens)).toBe(10);
		expect(Number(asst.rows[0].output_tokens)).toBe(5);

		const user = await ctx.db.query<{ role: string; content: string }>(
			'SELECT role, content FROM chat_messages WHERE id = $1',
			[userMessageId],
		);
		expect(user.rows[0].content).toBe('Hello CEO');

		const deltas = captured.events.filter((e) => e.type === 'chat_message_delta');
		expect(deltas.some((d) => d.text === 'Hi there')).toBe(true);
		expect(captured.events.some((e) => e.type === 'chat_message_complete')).toBe(true);

		await manager.stop();
	});

	test('provisions the HQ container on demand when it is not running', async () => {
		// A fresh instance exposes the CEO chat before any project is created, so the
		// HQ container may never have been provisioned. The turn must bring it up
		// rather than failing with "HQ container is not running".
		//
		// The pool rows go too, not just the project column: earlier tests in this
		// file provision, and each leaves a member behind. Now that the chat resolves
		// its container through the pool rather than through `projects.container_id`,
		// clearing only the column left this spec inheriting a perfectly good member
		// and asserting a provisioning path it had not actually taken.
		await ctx.db.query(
			`UPDATE projects SET container_id = NULL, container_status = 'stopped'
			 WHERE team_id = $1 AND is_internal = true`,
			[DEFAULT_TEAM_ID],
		);
		await ctx.db.query(
			`DELETE FROM container_pool_members WHERE project_id IN (
			   SELECT id FROM projects WHERE team_id = $1 AND is_internal = true)`,
			[DEFAULT_TEAM_ID],
		);

		const chat = makeChatDocker(ctx.dataDir, projectId);
		const { manager } = makeManager(ctx, chat.docker);

		const { assistantMessageId } = await manager.sendTurn({ text: 'Hello CEO' });
		await poll(async () => {
			const r = await ctx.db.query<{ status: string }>(
				'SELECT status FROM chat_messages WHERE id = $1',
				[assistantMessageId],
			);
			return r.rows[0]?.status === ChatMessageStatus.Complete;
		});

		const proj = await ctx.db.query<{ container_id: string | null; container_status: string }>(
			`SELECT container_id, container_status FROM projects WHERE team_id = $1 AND is_internal = true`,
			[DEFAULT_TEAM_ID],
		);
		expect(proj.rows[0].container_status).toBe('running');
		expect(proj.rows[0].container_id).toBeTruthy();

		await manager.stop();
	});

	test('second turn composes prior history into the prompt', async () => {
		const chat = makeChatDocker(ctx.dataDir, projectId);
		const { manager } = makeManager(ctx, chat.docker);

		const first = await manager.sendTurn({ text: 'What is the status?' });
		await poll(async () => {
			const r = await ctx.db.query<{ status: string }>(
				'SELECT status FROM chat_messages WHERE id = $1',
				[first.assistantMessageId],
			);
			return r.rows[0]?.status === ChatMessageStatus.Complete;
		});

		await manager.sendTurn({ text: 'And the next step?' });
		await poll(async () => chat.prompts.filter(isReplyPrompt).length >= 2);

		const replyPrompts = chat.prompts.filter(isReplyPrompt);
		const secondPrompt = replyPrompts[replyPrompts.length - 1];
		expect(secondPrompt).toContain('What is the status?');
		expect(secondPrompt).toContain('Hi there');
		expect(secondPrompt).toContain('And the next step?');

		// The chat roams across projects, so the prompt must not carry the home-team
		// (HQ) Project State block — that pin is what made the CEO report every project
		// as empty. Run Context carries cross-team guidance instead of HQ identifiers.
		expect(secondPrompt).not.toContain('## Project State');
		expect(secondPrompt).toContain('You are not scoped to a single project');

		await manager.stop();
	});

	test('the chat prompt steers file production, project scoping and off-project memory', async () => {
		const chat = makeChatDocker(ctx.dataDir, projectId);
		const { manager } = makeManager(ctx, chat.docker);

		await manager.sendTurn({ text: 'whip up a quick demo for me' });
		// The parallel auto-title exec also records a prompt; select the reply turn.
		await poll(async () => chat.prompts.some(isReplyPrompt));

		const prompt = chat.prompts.find(isReplyPrompt) as string;
		// Persist operator-facing deliverables to an assets library and link them,
		// instead of dropping a loose /workspace file the operator can't reach.
		expect(prompt).toContain('write_project_asset');
		expect(prompt).toContain('assets/<filename>');
		// Scope the deliverable to the relevant project, not HQ by default.
		expect(prompt).toContain('the project the work belongs to');
		// Off-project conversations get a rough summary in the auto-maintained
		// long-term memory (they live nowhere else once the window scrolls).
		expect(prompt).toContain('off-project threads');
		expect(prompt).toContain('update_chat_memory');

		await manager.stop();
	});

	test('the chat prompt embeds the full Hezo documentation at the HEZO_DOCS marker', async () => {
		const chat = makeChatDocker(ctx.dataDir, projectId);
		const { manager } = makeManager(ctx, chat.docker);

		await manager.sendTurn({ text: 'how does Hezo work?' });
		// The parallel auto-title exec also records a prompt; select the reply turn.
		await poll(async () => chat.prompts.some(isReplyPrompt));

		const prompt = chat.prompts.find(isReplyPrompt) as string;
		// The live chat resolves embedDocs:true, so the bundled docs are injected
		// at the CEO prompt's HEZO_DOCS marker — not the inert marker comment.
		expect(prompt).toContain('# Hezo documentation');
		expect(prompt).toContain('### Installation');
		expect(prompt).not.toContain('HEZO_DOCS:');

		await manager.stop();
	});

	test('a new message interrupts the in-flight reply', async () => {
		const chat = makeChatDocker(ctx.dataDir, projectId);
		chat.scenario.mode = 'block';
		const { manager } = makeManager(ctx, chat.docker);

		const first = await manager.sendTurn({ text: 'Long question' });
		await poll(async () => chat.scenario.entered);

		// Next message: switch the stub to reply so the new turn completes.
		chat.scenario.mode = 'reply';
		const second = await manager.sendTurn({ text: 'Actually, never mind' });

		await poll(async () => {
			const r = await ctx.db.query<{ status: string }>(
				'SELECT status FROM chat_messages WHERE id = $1',
				[first.assistantMessageId],
			);
			return r.rows[0]?.status === ChatMessageStatus.Interrupted;
		});
		await poll(async () => {
			const r = await ctx.db.query<{ status: string }>(
				'SELECT status FROM chat_messages WHERE id = $1',
				[second.assistantMessageId],
			);
			return r.rows[0]?.status === ChatMessageStatus.Complete;
		});

		await manager.stop();
	});

	test('an interrupted turn is reaped by its per-exec scope, never the shared session id', async () => {
		const chat = makeChatDocker(ctx.dataDir, projectId);
		chat.scenario.mode = 'block';

		// Capture each exec's per-exec scope id and every marker kill fired.
		const execScopeIds: string[] = [];
		const kills: Array<{ containerId: string; name: string; value: string }> = [];
		const innerCreate = chat.docker.execCreate.bind(chat.docker);
		chat.docker.execCreate = async (id: string, config: { Env?: string[] }) => {
			const scope = (config.Env ?? []).find((e) => e.startsWith('HEZO_EXEC_SCOPE_ID='));
			if (scope) execScopeIds.push(scope.slice('HEZO_EXEC_SCOPE_ID='.length));
			return innerCreate(id, config as never);
		};
		chat.docker.killProcessesByEnvMarker = async (
			containerId: string,
			name: 'HEZO_HEARTBEAT_RUN_ID' | 'HEZO_EXEC_SCOPE_ID',
			value: string,
		) => {
			kills.push({ containerId, name, value });
		};

		const { manager } = makeManager(ctx, chat.docker);
		const first = await manager.sendTurn({ text: 'Long question' });
		await poll(async () => chat.scenario.entered);

		chat.scenario.mode = 'reply';
		await manager.sendTurn({ text: 'Actually, never mind' });
		await poll(async () => {
			const r = await ctx.db.query<{ status: string }>(
				'SELECT status FROM chat_messages WHERE id = $1',
				[first.assistantMessageId],
			);
			return r.rows[0]?.status === ChatMessageStatus.Interrupted;
		});

		const session = await ctx.db.query<{ id: string }>(
			`SELECT id FROM chat_sessions WHERE status IN ($1, $2) ORDER BY started_at DESC LIMIT 1`,
			[ChatSessionStatus.Starting, ChatSessionStatus.Running],
		);
		const sessionId = session.rows[0].id;

		// The interrupt reaps by the aborted exec's own scope id — a session-wide
		// kill here would murder the second conversation-turn's live exec.
		await poll(async () => kills.some((k) => k.name === 'HEZO_EXEC_SCOPE_ID'));
		for (const kill of kills.filter((k) => k.name === 'HEZO_EXEC_SCOPE_ID')) {
			expect(kill.containerId).toBe('hq-container');
			expect(kill.value).not.toBe(sessionId);
			expect(execScopeIds).toContain(kill.value);
		}

		// Stopping the manager tears the session down and reaps session-wide: every
		// exec of this session carried HEZO_HEARTBEAT_RUN_ID=<sessionId>.
		await manager.stop();
		expect(kills).toContainEqual({
			containerId: 'hq-container',
			name: 'HEZO_HEARTBEAT_RUN_ID',
			value: sessionId,
		});
	});

	test('ensureSession is idempotent (one live session per CEO)', async () => {
		const chat = makeChatDocker(ctx.dataDir, projectId);
		const { manager } = makeManager(ctx, chat.docker);

		const a = await manager.sendTurn({ text: 'one' });
		await poll(async () => {
			const r = await ctx.db.query<{ status: string }>(
				'SELECT status FROM chat_messages WHERE id = $1',
				[a.assistantMessageId],
			);
			return r.rows[0]?.status === ChatMessageStatus.Complete;
		});
		await manager.sendTurn({ text: 'two' });

		const live = await ctx.db.query<{ n: number }>(
			`SELECT COUNT(*)::int AS n FROM chat_sessions WHERE status IN ($1, $2)`,
			[ChatSessionStatus.Starting, ChatSessionStatus.Running],
		);
		expect(live.rows[0].n).toBe(1);

		await manager.stop();
	});

	test('reconcileOnStartup marks orphaned sessions crashed', async () => {
		const ceo = await ctx.db.query<{ id: string }>(
			`SELECT m.id FROM members m JOIN member_agents ma ON ma.id = m.id WHERE ma.slug = 'ceo' AND m.team_id = $1`,
			[DEFAULT_TEAM_ID],
		);
		await ctx.db.query(
			`INSERT INTO chat_sessions (member_id, team_id, project_id, runtime_type, status)
			 VALUES ($1, $2, $3, 'claude_code', 'running')`,
			[ceo.rows[0].id, DEFAULT_TEAM_ID, projectId],
		);
		const { manager } = makeManager(ctx, makeChatDocker(ctx.dataDir, projectId).docker);
		await manager.reconcileOnStartup();
		const r = await ctx.db.query<{ status: string }>('SELECT status FROM chat_sessions LIMIT 1');
		expect(r.rows[0].status).toBe(ChatSessionStatus.Crashed);
	});

	test('reconcileOnStartup clears orphaned streaming messages (deletes empty, interrupts partial)', async () => {
		const { manager } = makeManager(ctx, makeChatDocker(ctx.dataDir, projectId).docker);
		const conversationId = await manager.getConversationId();
		const insert = async (status: string, content: string, role = 'assistant') => {
			const r = await ctx.db.query<{ id: string }>(
				`INSERT INTO chat_messages (conversation_id, role, channel, status, content)
				 VALUES ($1, $2::chat_message_role, 'web'::chat_channel, $3::chat_message_status, $4)
				 RETURNING id`,
				[conversationId, role, status, content],
			);
			return r.rows[0].id;
		};
		const emptyStreaming = await insert('streaming', '');
		const partialStreaming = await insert('streaming', 'half a thought');
		const emptyPending = await insert('pending', '');
		const done = await insert('complete', 'all good');
		const userMsg = await insert('complete', 'hello', 'user');

		await manager.reconcileOnStartup();

		const rows = await ctx.db.query<{ id: string; status: string }>(
			'SELECT id, status FROM chat_messages',
		);
		const byId = new Map(rows.rows.map((r) => [r.id, r.status]));
		// Empty orphaned placeholders (the stuck "thinking" dots) are deleted.
		expect(byId.has(emptyStreaming)).toBe(false);
		expect(byId.has(emptyPending)).toBe(false);
		// A partial reply is preserved, marked interrupted; terminal rows untouched.
		expect(byId.get(partialStreaming)).toBe(ChatMessageStatus.Interrupted);
		expect(byId.get(done)).toBe(ChatMessageStatus.Complete);
		expect(byId.get(userMsg)).toBe(ChatMessageStatus.Complete);
	});

	test('serializes concurrent sends — no overlapping turns or orphaned streaming rows', async () => {
		const { manager } = makeManager(ctx, makeChatDocker(ctx.dataDir, projectId).docker);

		// Two sends fired together (the impatient double-send during a slow gate).
		const [a, b] = await Promise.all([
			manager.sendTurn({ text: 'first' }),
			manager.sendTurn({ text: 'second' }),
		]);
		expect(a.assistantMessageId).not.toBe(b.assistantMessageId);

		// Every turn finalizes to a terminal state — none left streaming (the earlier is
		// interrupted by the later, which the mutex makes deterministic).
		await poll(async () => {
			const r = await ctx.db.query<{ n: number }>(
				`SELECT COUNT(*)::int AS n FROM chat_messages WHERE role = 'assistant' AND status = $1`,
				[ChatMessageStatus.Streaming],
			);
			return r.rows[0].n === 0;
		});

		// Exactly one assistant row per send (not duplicated) and a single live session.
		const assistants = await ctx.db.query<{ n: number }>(
			`SELECT COUNT(*)::int AS n FROM chat_messages WHERE role = 'assistant'`,
		);
		expect(assistants.rows[0].n).toBe(2);
		const sessions = await ctx.db.query<{ n: number }>(
			`SELECT COUNT(*)::int AS n FROM chat_sessions WHERE status IN ($1, $2)`,
			[ChatSessionStatus.Starting, ChatSessionStatus.Running],
		);
		expect(sessions.rows[0].n).toBe(1);

		await manager.stop();
	});

	test('creates the default web thread untitled (no hardcoded title)', async () => {
		const { docker } = makeChatDocker(ctx.dataDir, projectId);
		const { manager } = makeManager(ctx, docker);
		// Resolving the default web thread must store NULL, not a hardcoded "Main" — the
		// frontend renders NULL as "New thread" and the CEO auto-titles it later.
		const id = await manager.getConversationId();
		const convo = await manager.getConversation(id);
		expect(convo?.title).toBeNull();
		await manager.stop();
	});

	test('auto-titles an untitled thread from the first message and broadcasts it', async () => {
		const { docker } = makeChatDocker(ctx.dataDir, projectId);
		const { manager, wsManager } = makeManager(ctx, docker);
		const captured = captureCeoRoom(wsManager);

		const { conversationId } = await manager.sendTurn({ text: 'Hello CEO' });

		// The title exec streams "Hi there" (the stub replies the same to every exec);
		// poll until the background auto-title lands.
		await poll(async () => {
			const convo = await manager.getConversation(conversationId);
			return convo?.title != null;
		});
		const convo = await manager.getConversation(conversationId);
		expect(convo?.title).toBe('Hi there');
		// The switcher/rail learns about it live via a broadcast.
		expect(
			captured.events.some((e) => e.type === 'chat_conversation_updated' && e.title === 'Hi there'),
		).toBe(true);

		await manager.stop();
	});

	test('titles a new thread from the first message while the reply is still streaming', async () => {
		// The reply exec blocks (never completes); only the parallel title exec returns.
		// If titling still waited for the reply to settle, the thread would stay untitled.
		const { docker } = makeTitleRoutingDocker(ctx.dataDir, projectId, 'Deploy Pipeline Setup');
		const { manager, wsManager } = makeManager(ctx, docker);
		const captured = captureCeoRoom(wsManager);

		const { conversationId, assistantMessageId } = await manager.sendTurn({
			text: 'How do I set up the deploy pipeline?',
		});

		await poll(async () => {
			const convo = await manager.getConversation(conversationId);
			return convo?.title != null;
		});
		const convo = await manager.getConversation(conversationId);
		expect(convo?.title).toBe('Deploy Pipeline Setup');
		// The reply is still streaming when the title lands — titling ran in parallel.
		const reply = await ctx.db.query<{ status: string }>(
			'SELECT status FROM chat_messages WHERE id = $1',
			[assistantMessageId],
		);
		expect(reply.rows[0].status).toBe(ChatMessageStatus.Streaming);
		expect(
			captured.events.some(
				(e) => e.type === 'chat_conversation_updated' && e.title === 'Deploy Pipeline Setup',
			),
		).toBe(true);

		await manager.stop();
	});

	test('does not overwrite an existing thread title', async () => {
		const { docker } = makeChatDocker(ctx.dataDir, projectId);
		const { manager } = makeManager(ctx, docker);
		const titled = await manager.createWebConversation('Roadmap planning');

		const { assistantMessageId } = await manager.sendTurn({
			text: 'Hello',
			conversationId: titled,
		});
		await poll(async () => {
			const r = await ctx.db.query<{ status: string }>(
				'SELECT status FROM chat_messages WHERE id = $1',
				[assistantMessageId],
			);
			return r.rows[0]?.status === ChatMessageStatus.Complete;
		});
		// Auto-title is chained right after the reply and skips a thread that already has
		// a title, so the title can only stay as set.
		const convo = await manager.getConversation(titled);
		expect(convo?.title).toBe('Roadmap planning');
		await manager.stop();
	});
});

describe('CEO session auth', () => {
	let ctx: ServerTestContext;

	beforeAll(async () => {
		ctx = await createTestContext();
	});
	afterAll(async () => {
		await destroyTestContext(ctx);
	});

	test('a session token authenticates with cross-team while running, fails when stopped', async () => {
		const ceo = await ctx.db.query<{ id: string }>(
			`SELECT m.id FROM members m JOIN member_agents ma ON ma.id = m.id WHERE ma.slug = 'ceo' AND m.team_id = $1`,
			[DEFAULT_TEAM_ID],
		);
		const project = await ctx.db.query<{ id: string }>(
			`SELECT id FROM projects WHERE team_id = $1 AND is_internal = true`,
			[DEFAULT_TEAM_ID],
		);
		const session = await ctx.db.query<{ id: string }>(
			`INSERT INTO chat_sessions (member_id, team_id, project_id, runtime_type, status)
			 VALUES ($1, $2, $3, 'claude_code', 'running') RETURNING id`,
			[ceo.rows[0].id, DEFAULT_TEAM_ID, project.rows[0].id],
		);
		const sessionId = session.rows[0].id;
		const token = await signChatSessionJwt(
			ctx.masterKeyManager,
			ceo.rows[0].id,
			DEFAULT_TEAM_ID,
			sessionId,
			project.rows[0].id,
		);

		const auth = await verifyToken(token, ctx.db, ctx.masterKeyManager);
		expect(auth?.type).toBe(AuthType.Agent);
		if (auth?.type !== AuthType.Agent) throw new Error('expected agent auth');
		expect(auth.sessionId).toBe(sessionId);
		expect(auth.crossTeam).toBe(true);
		expect(auth.crossProject).toBe(true);
		expect(auth.runId).toBeNull();

		await ctx.db.query(`UPDATE chat_sessions SET status = 'stopped' WHERE id = $1`, [sessionId]);
		const denied = await verifyToken(token, ctx.db, ctx.masterKeyManager);
		expect(denied).toBeNull();
	});
});
