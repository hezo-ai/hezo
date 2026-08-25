import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	AgentRuntime,
	AiAuthMethod,
	AuthType,
	ChatMessageStatus,
	ChatSessionStatus,
	ChatSystemMessageKind,
	DEFAULT_TEAM_ID,
	setCredentialSerializationRulesForTest,
	WsMessageType,
	wsRoom,
} from '@hezo/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { decrypt, encrypt } from '../src/crypto/encryption';
import { setMonthlyContainerHours } from '../src/lib/system-meta';
import {
	canAuthAccessTeam,
	signChatSessionJwt,
	verifyToken,
	WORKER_SESSION_JWT_TTL_SECONDS,
} from '../src/middleware/auth';
import { acquireCredentialLock } from '../src/services/agent-runner';
import { type CeoSessionDeps, ChatSessionManager } from '../src/services/chat-session-manager';
import type { ExecLogChunk } from '../src/services/docker';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import type { PricingService } from '../src/services/pricing/pricing-service';
import { getWorkspacePath } from '../src/services/workspace';
import type { WsSocket } from '../src/services/ws';
import { WebSocketManager } from '../src/services/ws';
import { createStubDocker, seedProjectContainer } from './helpers/app';
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
function makeChatDocker(dataDir: string, projectId: string, teamId = DEFAULT_TEAM_ID): ChatDocker {
	const prompts: string[] = [];
	const scenario = { mode: 'reply' as 'reply' | 'block', entered: false };
	const toHostPath = (containerPath: string) =>
		join(getWorkspacePath(dataDir, teamId, projectId), containerPath.replace(/^\/workspace\//, ''));

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

/**
 * Capture what an open chatbox receives: the global boundary-event room plus,
 * lazily, each conversation's own room (deltas stream only there - the client
 * joins a thread's room when it opens the thread). The lazy join keys off the
 * conversationId on the first boundary event, mirroring the real client.
 */
function captureCeoRoom(wsManager: WebSocketManager): { events: Array<Record<string, unknown>> } {
	const events: Array<Record<string, unknown>> = [];
	const joined = new Set<string>();
	const socket: WsSocket = {
		data: { auth: { type: AuthType.Admin, isSuperuser: true }, rooms: new Set() },
		send: (msg: string) => {
			const event = JSON.parse(msg) as Record<string, unknown>;
			events.push(event);
			const convoId = event.conversationId;
			if (typeof convoId === 'string' && !joined.has(convoId)) {
				joined.add(convoId);
				wsManager.subscribe(socket, wsRoom.chatConversation(convoId));
			}
		},
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
		`SELECT id FROM projects WHERE team_id = $1 AND is_internal = true`,
		[DEFAULT_TEAM_ID],
	);
	// The pool has to say the same thing as the column, because the chat resolves
	// its container through the pool now. Re-seeding only the column left members
	// behind from earlier tests - including one a provisioning spec created - and
	// the ladder handed the next test that container instead of `hq-container`,
	// which is the seeded premise every spec in this file is written against.
	await ctx.db.query('DELETE FROM container_pool_members WHERE project_id = $1', [proj.rows[0].id]);
	await seedProjectContainer(ctx.db, proj.rows[0].id, 'hq-container');
	return proj.rows[0].id;
}

function makeManager(
	ctx: ServerTestContext,
	docker: ReturnType<typeof createStubDocker>,
	extra: Partial<CeoSessionDeps> = {},
) {
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
		...extra,
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

	const ceoId = async (): Promise<string> => {
		const r = await ctx.db.query<{ id: string }>(
			`SELECT m.id FROM members m JOIN member_agents ma ON ma.id = m.id
			 WHERE ma.slug = 'ceo' AND m.team_id = $1`,
			[DEFAULT_TEAM_ID],
		);
		return r.rows[0].id;
	};

	test('refuses a turn over budget: the message stands, a system row says why, no exec runs', async () => {
		// Chat is metered, so the pre-turn gate mirrors a run's. The operator's
		// message is persisted before the gate - a refusal must never eat it.
		const chat = makeChatDocker(ctx.dataDir, projectId);
		const { manager } = makeManager(ctx, chat.docker);
		const ceo = await ceoId();
		await ctx.db.query(`UPDATE member_agents SET daily_budget_cents = 1 WHERE id = $1`, [ceo]);
		await ctx.db.query(
			`INSERT INTO cost_entries (member_id, amount_cents, description) VALUES ($1, 5, 'prior')`,
			[ceo],
		);
		try {
			const res = await manager.sendTurn({ text: 'hello?' });
			const rows = await ctx.db.query<{
				id: string;
				role: string;
				system_kind: string | null;
				content: string;
			}>(
				`SELECT id, role::text AS role, system_kind, content FROM chat_messages
				 WHERE conversation_id = $1 ORDER BY created_at ASC`,
				[res.conversationId],
			);
			expect(rows.rows.map((r) => r.role)).toEqual(['user', 'system']);
			expect(rows.rows[1].system_kind).toBe(ChatSystemMessageKind.BudgetExceeded);
			expect(rows.rows[1].content).toContain('daily budget');
			expect(res.assistantMessageId).toBe(rows.rows[1].id);
			expect(chat.scenario.entered).toBe(false);
		} finally {
			await ctx.db.query(`UPDATE member_agents SET daily_budget_cents = 0 WHERE id = $1`, [ceo]);
			await ctx.db.query(`DELETE FROM cost_entries WHERE member_id = $1`, [ceo]);
			await manager.stop();
		}
	});

	test('maps an exhausted hours allowance to the budget-exceeded row', async () => {
		// Decision-level: an exhausted container-hours cap pauses the CEO chat too.
		// No container to reuse and no project pointer to adopt, so the acquire
		// must create - which is exactly what the spent allowance refuses.
		const chat = makeChatDocker(ctx.dataDir, projectId);
		const { manager } = makeManager(ctx, chat.docker);
		await ctx.db.query('DELETE FROM container_pool_members WHERE project_id = $1', [projectId]);
		await ctx.db.query(`UPDATE projects SET container_id = NULL WHERE id = $1`, [projectId]);
		await setMonthlyContainerHours(ctx.db, 10);
		await ctx.db.query(
			`INSERT INTO container_uptime_entries (container_id, started_at, ended_at, backend)
			 VALUES ('spent-chat-test', date_trunc('month', now() AT TIME ZONE 'UTC'),
			         date_trunc('month', now() AT TIME ZONE 'UTC') + interval '10 hours', 'docker')`,
		);
		try {
			const res = await manager.sendTurn({ text: 'hello?' });
			const rows = await ctx.db.query<{ role: string; system_kind: string | null }>(
				`SELECT role::text AS role, system_kind FROM chat_messages
				 WHERE conversation_id = $1 ORDER BY created_at ASC`,
				[res.conversationId],
			);
			expect(rows.rows.map((r) => r.role)).toEqual(['user', 'system']);
			expect(rows.rows[1].system_kind).toBe(ChatSystemMessageKind.BudgetExceeded);
		} finally {
			await setMonthlyContainerHours(ctx.db, 0);
			await ctx.db.query(
				`DELETE FROM container_uptime_entries WHERE container_id = 'spent-chat-test'`,
			);
			await manager.stop();
		}
	});

	test('bills a completed turn to cost_entries under the CEO and HQ', async () => {
		const chat = makeChatDocker(ctx.dataDir, projectId);
		const pricing = { costCents: () => 3 } as unknown as PricingService;
		const { manager } = makeManager(ctx, chat.docker, { pricing });
		const { assistantMessageId } = await manager.sendTurn({ text: 'hi' });
		await poll(async () => {
			const r = await ctx.db.query<{ status: string }>(
				`SELECT status::text AS status FROM chat_messages WHERE id = $1`,
				[assistantMessageId],
			);
			return r.rows[0]?.status === ChatMessageStatus.Complete;
		});
		await poll(async () => {
			const r = await ctx.db.query<{ n: number }>(
				`SELECT COUNT(*)::int AS n FROM cost_entries WHERE description = 'Chat turn'`,
			);
			return r.rows[0].n === 1;
		});
		const entry = await ctx.db.query<{
			member_id: string;
			project_id: string | null;
			task_id: string | null;
			amount_cents: number;
		}>(`SELECT member_id, project_id, task_id, amount_cents FROM cost_entries
		    WHERE description = 'Chat turn'`);
		expect(entry.rows[0].member_id).toBe(await ceoId());
		expect(entry.rows[0].project_id).toBe(projectId);
		expect(entry.rows[0].task_id).toBeNull();
		expect(entry.rows[0].amount_cents).toBe(3);
		await manager.stop();
		await ctx.db.query(`DELETE FROM cost_entries`);
	});

	test('points a file-delivery runtime at the turn its prompt was written for', async () => {
		// Grok reads the prompt file itself, so its path is part of argv - and
		// `execCmd` is built ONCE per session, against the session-keyed path. Each
		// turn writes a conversation-keyed file instead, so without the per-turn
		// swap in `turnPrompt` the CLI would open a path nothing ever writes and
		// every reply would run on an empty prompt.
		await ctx.db.query('DELETE FROM ai_provider_configs');
		const key = ctx.masterKeyManager.getKey();
		if (!key) throw new Error('master key unavailable');
		await ctx.db.query(
			`INSERT INTO ai_provider_configs (provider, auth_method, label, encrypted_credential, is_default, status, default_model)
			 VALUES ('x_ai', 'api_key', 'grok', $1, true, 'verified', 'grok-4.5')`,
			[encrypt('xai-test', key)],
		);

		const cmds: string[][] = [];
		const grokDocker = createStubDocker({
			execCreate: async (_id: string, config: { Cmd?: string[] }) => {
				cmds.push(config.Cmd ?? []);
				return 'exec-grok';
			},
			execStart: async (
				_execId: string,
				opts: { onChunk?: (c: ExecLogChunk) => void | Promise<void> },
			) => {
				const onChunk = opts.onChunk ?? (() => undefined);
				await onChunk({
					stream: 'stdout',
					text: `${JSON.stringify({ type: 'text', data: 'Hi there' })}\n`,
				});
				await onChunk({ stream: 'stdout', text: `${JSON.stringify({ type: 'end' })}\n` });
				return { stdout: '', stderr: '' };
			},
		});
		const { manager } = makeManager(ctx, grokDocker);

		const { assistantMessageId } = await manager.sendTurn({ text: 'Hello CEO' });
		await poll(async () => {
			const r = await ctx.db.query<{ status: string }>(
				'SELECT status FROM chat_messages WHERE id = $1',
				[assistantMessageId],
			);
			return r.rows[0]?.status === ChatMessageStatus.Complete;
		});

		const conversationId = (
			await ctx.db.query<{ conversation_id: string }>(
				'SELECT conversation_id FROM chat_messages WHERE id = $1',
				[assistantMessageId],
			)
		).rows[0].conversation_id;
		const sessionId = (await ctx.db.query<{ id: string }>('SELECT id FROM chat_sessions LIMIT 1'))
			.rows[0].id;

		// Only the CLI execs carry the flag; the session also runs shell execs (prep,
		// git) through the same stub.
		const promptArgs = cmds
			.filter((c) => c.includes('--prompt-file'))
			.map((c) => c[c.indexOf('--prompt-file') + 1]);
		expect(promptArgs.length).toBeGreaterThan(0);
		for (const arg of promptArgs) {
			expect(arg).toContain(conversationId);
			// The session-keyed path is what `execCmd` was built with; no exec may
			// still be pointing at it.
			expect(arg).not.toBe(`/workspace/.hezo/prompts/${sessionId}.txt`);
		}

		await manager.stop();
	});

	test('broadcasts tool activity as progress, keeping it out of the reply text', async () => {
		// The runtimes emit whole assistant messages, not token deltas, so a turn
		// that calls a tool after writing its text is indistinguishable from a
		// finished one - the operator sees only the dots. The activity event is what
		// gives those dots a reason; it is progress, so it must never land in the
		// message the conversation keeps.
		const toolDocker = createStubDocker({
			execCreate: async () => 'exec-1',
			execStart: async (
				_execId: string,
				opts: { onChunk?: (c: ExecLogChunk) => void | Promise<void> },
			) => {
				const onChunk = opts.onChunk ?? (() => undefined);
				await onChunk({ stream: 'stdout', text: assistantText('Checking the roster.') });
				await onChunk({
					stream: 'stdout',
					text: claudeLine({
						type: 'assistant',
						message: {
							role: 'assistant',
							content: [{ type: 'tool_use', name: 'mcp__hezo__list_agents' }],
						},
					}),
				});
				await onChunk({ stream: 'stdout', text: resultEvent(10, 5, 0.02) });
				return { stdout: '', stderr: '' };
			},
		});
		const { manager, wsManager } = makeManager(ctx, toolDocker);
		const captured = captureCeoRoom(wsManager);

		const { assistantMessageId } = await manager.sendTurn({ text: 'who is on the team?' });
		await poll(async () => {
			const r = await ctx.db.query<{ status: string }>(
				'SELECT status FROM chat_messages WHERE id = $1',
				[assistantMessageId],
			);
			return r.rows[0]?.status === ChatMessageStatus.Complete;
		});

		// A subscriber of both rooms receives each boundary event once per room;
		// the client handles them idempotently, so distinctness is the contract.
		const activity = captured.events.filter((e) => e.type === 'chat_message_tool_activity');
		expect(activity.length).toBeGreaterThanOrEqual(1);
		expect(new Set(activity.map((a) => `${a.messageId}:${a.tool}`)).size).toBe(1);
		expect(activity[0].tool).toBe('mcp__hezo__list_agents');
		expect(activity[0].messageId).toBe(assistantMessageId);

		// The stored reply is the text alone — no tool name leaked into it.
		const asst = await ctx.db.query<{ content: string }>(
			'SELECT content FROM chat_messages WHERE id = $1',
			[assistantMessageId],
		);
		expect(asst.rows[0].content).toBe('Checking the roster.');

		await manager.stop();
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

	test('a moved instance default reaches a session that is already live', async () => {
		// A session resolves its provider, CLI and model once and bakes them into the
		// container env and exec command, so an agent following the instance default
		// would otherwise keep running on the credential that was default the day its
		// session started - for as long as the session lived.
		const envs: string[][] = [];
		const chatDocker = createStubDocker({
			execCreate: async (_id: string, config: { Env?: string[] }) => {
				const env = config.Env ?? [];
				if (env.some((e) => e.startsWith('HEZO_PROMPT_FILE='))) envs.push(env);
				return 'exec-1';
			},
			execStart: async (
				_execId: string,
				opts: { onChunk?: (c: ExecLogChunk) => void | Promise<void> },
			) => {
				const onChunk = opts.onChunk ?? (() => undefined);
				await onChunk({ stream: 'stdout', text: assistantText('Hi there') });
				await onChunk({ stream: 'stdout', text: resultEvent(10, 5, 0.02) });
				return { stdout: '', stderr: '' };
			},
		});
		const { manager } = makeManager(ctx, chatDocker);
		const settle = async (assistantMessageId: string) =>
			poll(async () => {
				const r = await ctx.db.query<{ status: string }>(
					'SELECT status FROM chat_messages WHERE id = $1',
					[assistantMessageId],
				);
				return r.rows[0]?.status === ChatMessageStatus.Complete;
			});

		const first = await manager.sendTurn({ text: 'before' });
		await settle(first.assistantMessageId);
		const deepseekBaseUrl = 'ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic';
		expect(envs.length).toBeGreaterThan(0);
		expect(envs.every((env) => !env.includes(deepseekBaseUrl))).toBe(true);

		// The operator moves the instance default onto a different credential. DeepSeek
		// shares the Claude Code runtime with the seeded Anthropic config, so the CLI
		// is unchanged and only the credential behind it moves - the case a session
		// reusing its own snapshot cannot notice at all.
		const key = ctx.masterKeyManager.getKey();
		if (!key) throw new Error('master key unavailable');
		await ctx.db.query(`UPDATE ai_provider_configs SET is_default = false`);
		await ctx.db.query(
			`INSERT INTO ai_provider_configs (provider, auth_method, label, encrypted_credential, is_default, status, default_model)
			 VALUES ('deepseek', 'api_key', 'deepseek', $1, true, 'verified', 'deepseek-v4-pro')`,
			[encrypt('sk-deepseek', key)],
		);

		const before = envs.length;
		const second = await manager.sendTurn({ text: 'after' });
		await settle(second.assistantMessageId);

		const afterMove = envs.slice(before);
		expect(afterMove.length).toBeGreaterThan(0);
		expect(afterMove.every((env) => env.includes(deepseekBaseUrl))).toBe(true);

		// The old session was retired rather than mutated, so exactly one is live.
		const sessions = await ctx.db.query<{ n: number }>(
			`SELECT COUNT(*)::int AS n FROM chat_sessions WHERE status IN ($1, $2)`,
			[ChatSessionStatus.Starting, ChatSessionStatus.Running],
		);
		expect(sessions.rows[0].n).toBe(1);
		const all = await ctx.db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM chat_sessions`);
		expect(all.rows[0].n).toBe(2);

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
		await manager.reconcileDatabaseOnStartup();
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

		await manager.reconcileDatabaseOnStartup();

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

	/**
	 * A chat turn drives the same coding CLI a task run does, so on a rotating
	 * subscription it consumes and rewrites the single-use refresh token. The chat
	 * used to take no lock and keep no write-back, so a turn overlapping a task run
	 * invalidated that run's token and dropped whatever the CLI left behind.
	 */
	describe('worker DM turns', () => {
		let n = 0;
		/** A project team with one enabled worker agent and a warm pool container. */
		async function seedWorker(): Promise<{
			teamId: string;
			projectId: string;
			memberId: string;
			containerId: string;
		}> {
			n += 1;
			const team = await ctx.db.query<{ id: string }>(
				`INSERT INTO teams (name, slug) VALUES ($1, $1) RETURNING id`,
				[`worker-co-${n}`],
			);
			const teamId = team.rows[0].id;
			const project = await ctx.db.query<{ id: string }>(
				`INSERT INTO projects (team_id, name, slug, task_prefix)
				 VALUES ($1, $2, $2, $3) RETURNING id`,
				[teamId, `storefront-${n}`, `ST${n}`],
			);
			const projectId = project.rows[0].id;
			const member = await ctx.db.query<{ id: string }>(
				`INSERT INTO members (team_id, member_type, display_name)
				 VALUES ($1, 'agent', 'Dev') RETURNING id`,
				[teamId],
			);
			const memberId = member.rows[0].id;
			await ctx.db.query(
				`INSERT INTO member_agents (id, title, slug) VALUES ($1, 'Developer', 'dev')`,
				[memberId],
			);
			const containerId = `worker-container-${n}`;
			await seedProjectContainer(ctx.db, projectId, containerId);
			return { teamId, projectId, memberId, containerId };
		}

		test('runs a DM turn end to end in the worker’s own scope', async () => {
			const w = await seedWorker();
			const chat = makeChatDocker(ctx.dataDir, w.projectId, w.teamId);
			const pricing = { costCents: () => 2 } as unknown as PricingService;
			const { manager } = makeManager(ctx, chat.docker, { pricing });
			const res = await manager.sendWorkerTurn({
				memberId: w.memberId,
				teamId: w.teamId,
				projectId: w.projectId,
				text: 'how is the storefront going?',
			});
			await poll(async () => {
				const r = await ctx.db.query<{ status: string }>(
					`SELECT status::text AS status FROM chat_messages WHERE id = $1`,
					[res.assistantMessageId],
				);
				return r.rows[0]?.status === ChatMessageStatus.Complete;
			});

			// The conversation is the worker's own DM in its project, not an HQ thread.
			const convo = await ctx.db.query<{
				member_id: string;
				team_id: string;
				project_id: string;
			}>(`SELECT member_id, team_id, project_id FROM chat_conversations WHERE id = $1`, [
				res.conversationId,
			]);
			expect(convo.rows[0]).toEqual({
				member_id: w.memberId,
				team_id: w.teamId,
				project_id: w.projectId,
			});

			// The reply is authored by the worker, and its prompt got the worker
			// guide on the chat diet - not the CEO's briefing, not the 80 KB task-run
			// shared instructions.
			const author = await ctx.db.query<{ author_member_id: string }>(
				`SELECT author_member_id FROM chat_messages WHERE id = $1`,
				[res.assistantMessageId],
			);
			expect(author.rows[0].author_member_id).toBe(w.memberId);
			const prompt = chat.prompts.find((p) => p.includes('in your own role'));
			expect(prompt).toBeDefined();
			expect(prompt).toContain('Chat thinks, tasks work');
			expect(prompt).toContain('Shared Guidance (chat)');
			expect(prompt).not.toContain('Reply to the latest operator message as the CEO.');

			// The session row is the worker's, scoped to its team; the container went
			// back to the pool when the turn ended (released, never pinned).
			const session = await ctx.db.query<{ member_id: string; team_id: string; status: string }>(
				`SELECT member_id, team_id, status::text AS status FROM chat_sessions
				 WHERE member_id = $1`,
				[w.memberId],
			);
			expect(session.rows[0]).toMatchObject({
				member_id: w.memberId,
				team_id: w.teamId,
				status: ChatSessionStatus.Running,
			});
			await poll(async () => {
				const r = await ctx.db.query<{ state: string; reserved: boolean }>(
					`SELECT state::text AS state, reserved_for_chat AS reserved
					 FROM container_pool_members WHERE container_id = $1`,
					[w.containerId],
				);
				return r.rows[0]?.state === 'idle' && r.rows[0]?.reserved === false;
			});

			// The spend landed under the worker and its project.
			const cost = await ctx.db.query<{ member_id: string; project_id: string }>(
				`SELECT member_id, project_id FROM cost_entries WHERE description = 'Chat turn'`,
			);
			expect(cost.rows).toHaveLength(1);
			expect(cost.rows[0]).toEqual({ member_id: w.memberId, project_id: w.projectId });

			await manager.stop();
			// stop() closes the worker session row so its JWTs stop validating.
			const after = await ctx.db.query<{ status: string }>(
				`SELECT status::text AS status FROM chat_sessions WHERE member_id = $1`,
				[w.memberId],
			);
			expect(after.rows[0].status).toBe(ChatSessionStatus.Stopped);
			await ctx.db.query(`DELETE FROM cost_entries`);
		});

		test('gates the turn on the worker’s own budget, not HQ’s', async () => {
			const w = await seedWorker();
			const chat = makeChatDocker(ctx.dataDir, w.projectId, w.teamId);
			const { manager } = makeManager(ctx, chat.docker);
			await ctx.db.query(`UPDATE member_agents SET daily_budget_cents = 1 WHERE id = $1`, [
				w.memberId,
			]);
			await ctx.db.query(
				`INSERT INTO cost_entries (member_id, amount_cents, description) VALUES ($1, 5, 'prior')`,
				[w.memberId],
			);
			try {
				const res = await manager.sendWorkerTurn({
					memberId: w.memberId,
					teamId: w.teamId,
					projectId: w.projectId,
					text: 'hello?',
				});
				const rows = await ctx.db.query<{ role: string; system_kind: string | null }>(
					`SELECT role::text AS role, system_kind FROM chat_messages
					 WHERE conversation_id = $1 ORDER BY created_at ASC`,
					[res.conversationId],
				);
				expect(rows.rows.map((r) => r.role)).toEqual(['user', 'system']);
				expect(rows.rows[1].system_kind).toBe(ChatSystemMessageKind.BudgetExceeded);
				expect(chat.scenario.entered).toBe(false);
			} finally {
				await ctx.db.query(`DELETE FROM cost_entries WHERE member_id = $1`, [w.memberId]);
				await manager.stop();
			}
		});

		test('refuses an explicit conversation belonging to someone else', async () => {
			const w = await seedWorker();
			const { manager } = makeManager(
				ctx,
				makeChatDocker(ctx.dataDir, w.projectId, w.teamId).docker,
			);
			// The CEO's default HQ thread is not this worker's to write into.
			const foreign = await manager.getConversationId();
			await expect(
				manager.sendWorkerTurn({
					memberId: w.memberId,
					teamId: w.teamId,
					projectId: w.projectId,
					conversationId: foreign,
					text: 'hi',
				}),
			).rejects.toThrow('conversation not found');
			await manager.stop();
		});
	});

	describe('credential rotation', () => {
		const ROTATED = JSON.stringify({
			tokens: {
				id_token: 'header.payload.sig2',
				access_token: 'header.payload.sig2',
				refresh_token: 'rt-rotated-by-chat',
				account_id: 'acct-1',
			},
		});
		const ORIGINAL = JSON.stringify({
			tokens: {
				id_token: 'header.payload.sig',
				access_token: 'header.payload.sig',
				refresh_token: 'rt-original',
				account_id: 'acct-1',
			},
		});

		/** A Codex subscription, the one credential shape that rotates. */
		async function seedCodexSubscription(): Promise<string> {
			const key = ctx.masterKeyManager.getKey();
			if (!key) throw new Error('master key unavailable');
			await ctx.db.query('DELETE FROM ai_provider_configs');
			const res = await ctx.db.query<{ id: string }>(
				`INSERT INTO ai_provider_configs (provider, auth_method, label, encrypted_credential, is_default, status, runtime)
				 VALUES ('openai', 'subscription', 'codex-sub', $1, true, 'verified', 'codex')
				 RETURNING id`,
				[encrypt(ORIGINAL, key)],
			);
			const proj = await ctx.db.query<{ id: string }>(
				`SELECT id FROM projects WHERE team_id = $1 AND is_internal = true`,
				[DEFAULT_TEAM_ID],
			);
			await ctx.db.query('DELETE FROM container_pool_members WHERE project_id = $1', [
				proj.rows[0].id,
			]);
			await seedProjectContainer(ctx.db, proj.rows[0].id, 'hq-container');
			return res.rows[0].id;
		}

		beforeEach(async () => {
			await ctx.db.query('DELETE FROM chat_messages');
			await ctx.db.query('DELETE FROM chat_sessions');
			await ctx.db.query('DELETE FROM chat_conversations');
			// Codex does not serialise by default any more; the lock/wait/notice tests
			// below drive the still-wired mechanism through a rule. Rotation read-back
			// runs regardless, so the read-back tests clear this to test the default.
			setCredentialSerializationRulesForTest([
				{ runtime: AgentRuntime.Codex, authMethod: AiAuthMethod.Subscription },
			]);
		});
		afterEach(() => setCredentialSerializationRulesForTest([]));

		test('holds the credential for the turn and stores what the CLI rotated into it', async () => {
			const configId = await seedCodexSubscription();
			let heldDuringExec = false;

			const docker = createStubDocker(
				{
					execCreate: async () => 'exec-codex-chat',
					execStart: async (
						_execId: string,
						opts: { onChunk?: (c: ExecLogChunk) => void | Promise<void> },
					) => {
						// A second acquirer cannot get in while the turn is running, which is
						// the whole point of taking the lock for the exec rather than around
						// the token read.
						const contender = acquireCredentialLock(configId, { timeoutMs: 20 }).then(
							(release: () => void) => {
								release();
								return false;
							},
							() => true,
						);
						heldDuringExec = await contender;
						const onChunk = opts.onChunk ?? (() => undefined);
						await onChunk({ stream: 'stdout', text: assistantText('Hello') });
						await onChunk({ stream: 'stdout', text: resultEvent(10, 5, 0.01) });
						return { stdout: '', stderr: '' };
					},
				},
				{ db: ctx.db, dataDir: ctx.dataDir },
			);
			const { manager } = makeManager(ctx, docker);

			const { assistantMessageId } = await manager.sendTurn({ text: 'Hello CEO' });
			await poll(async () => {
				const r = await ctx.db.query<{ status: string }>(
					'SELECT status FROM chat_messages WHERE id = $1',
					[assistantMessageId],
				);
				return r.rows[0]?.status === ChatMessageStatus.Complete;
			});

			expect(heldDuringExec).toBe(true);
			await manager.stop();
		});

		test('leaves a non-rotating credential unlocked, so chat and runs stay concurrent', async () => {
			const key = ctx.masterKeyManager.getKey();
			if (!key) throw new Error('master key unavailable');
			await ctx.db.query('DELETE FROM ai_provider_configs');
			const res = await ctx.db.query<{ id: string }>(
				`INSERT INTO ai_provider_configs (provider, auth_method, label, encrypted_credential, is_default, status, default_model)
				 VALUES ('anthropic', 'api_key', 'plain', $1, true, 'verified', 'claude-sonnet-4-6')
				 RETURNING id`,
				[encrypt('sk-ant-test', key)],
			);
			const proj = await ctx.db.query<{ id: string }>(
				`SELECT id FROM projects WHERE team_id = $1 AND is_internal = true`,
				[DEFAULT_TEAM_ID],
			);
			await ctx.db.query('DELETE FROM container_pool_members WHERE project_id = $1', [
				proj.rows[0].id,
			]);
			await seedProjectContainer(ctx.db, proj.rows[0].id, 'hq-container');

			let lockedOut = false;
			const docker = createStubDocker(
				{
					execCreate: async () => 'exec-anthropic-chat',
					execStart: async (
						_execId: string,
						opts: { onChunk?: (c: ExecLogChunk) => void | Promise<void> },
					) => {
						lockedOut = await acquireCredentialLock(res.rows[0].id, { timeoutMs: 20 }).then(
							(release: () => void) => {
								release();
								return false;
							},
							() => true,
						);
						const onChunk = opts.onChunk ?? (() => undefined);
						await onChunk({ stream: 'stdout', text: assistantText('Hi') });
						await onChunk({ stream: 'stdout', text: resultEvent(10, 5, 0.01) });
						return { stdout: '', stderr: '' };
					},
				},
				{ db: ctx.db, dataDir: ctx.dataDir },
			);
			const { manager } = makeManager(ctx, docker);

			const { assistantMessageId } = await manager.sendTurn({ text: 'Hello CEO' });
			await poll(async () => {
				const r = await ctx.db.query<{ status: string }>(
					'SELECT status FROM chat_messages WHERE id = $1',
					[assistantMessageId],
				);
				return r.rows[0]?.status === ChatMessageStatus.Complete;
			});

			// An API key is not rewritten by anything, so nothing should be serialised.
			expect(lockedOut).toBe(false);
			await manager.stop();
		});

		test('writes a rotated credential back rather than dropping it', async () => {
			// The read-back is independent of serialisation - a Codex turn rotates its
			// token and stores it whether or not runs queue. Test the default (no rule).
			setCredentialSerializationRulesForTest([]);
			const configId = await seedCodexSubscription();
			const key = ctx.masterKeyManager.getKey();
			if (!key) throw new Error('master key unavailable');

			// The CLI rewrites its auth file mid-exec, which is exactly when Codex
			// rotates. Written through SandboxFiles so the read-back path under test is
			// the same one production uses.
			let codexHome: string | null = null;
			const docker = createStubDocker(
				{
					execCreate: async (_id: string, config: { Env?: string[] }) => {
						const entry = (config.Env ?? []).find((e) => e.startsWith('CODEX_HOME='));
						if (entry) codexHome = entry.slice('CODEX_HOME='.length);
						return 'exec-codex-rotate';
					},
					execStart: async (
						_execId: string,
						opts: { onChunk?: (c: ExecLogChunk) => void | Promise<void> },
					) => {
						if (codexHome) {
							await docker.files('hq-container', codexHome).write('auth.json', ROTATED);
						}
						const onChunk = opts.onChunk ?? (() => undefined);
						await onChunk({ stream: 'stdout', text: assistantText('Rotated') });
						await onChunk({ stream: 'stdout', text: resultEvent(10, 5, 0.01) });
						return { stdout: '', stderr: '' };
					},
				},
				{ db: ctx.db, dataDir: ctx.dataDir },
			);
			const { manager } = makeManager(ctx, docker);
			const { assistantMessageId } = await manager.sendTurn({ text: 'Hello CEO' });
			await poll(async () => {
				const r = await ctx.db.query<{ status: string }>(
					'SELECT status FROM chat_messages WHERE id = $1',
					[assistantMessageId],
				);
				return r.rows[0]?.status === ChatMessageStatus.Complete;
			});

			expect(codexHome).not.toBeNull();
			// The turn stored what the CLI left behind. Dropping it left the row a
			// rotation behind, and the next refresh on that credential fails.
			const stored = await ctx.db.query<{ encrypted_credential: string }>(
				'SELECT encrypted_credential FROM ai_provider_configs WHERE id = $1',
				[configId],
			);
			expect(decrypt(stored.rows[0].encrypted_credential, key)).toBe(ROTATED);

			await manager.stop();
		});

		/** The docker every reply-shaped test uses: one exec that says hello. */
		function replyingDocker() {
			return createStubDocker(
				{
					execCreate: async () => 'exec-codex-chat',
					execStart: async (
						_execId: string,
						opts: { onChunk?: (c: ExecLogChunk) => void | Promise<void> },
					) => {
						const onChunk = opts.onChunk ?? (() => undefined);
						await onChunk({ stream: 'stdout', text: assistantText('Hello') });
						await onChunk({ stream: 'stdout', text: resultEvent(10, 5, 0.01) });
						return { stdout: '', stderr: '' };
					},
				},
				{ db: ctx.db, dataDir: ctx.dataDir },
			);
		}

		const HOLDER = {
			label: 'growth-analyst/HM-336',
			link: { projectSlug: 'hezo-marketing', agentSlug: 'growth-analyst', runId: 'run-hm-336' },
		};
		const HOLDER_TEXT =
			'[growth-analyst/HM-336](/projects/hezo-marketing/agents/growth-analyst/executions/run-hm-336)';

		test('tells the thread who holds the credential at once, then replies when it is free', async () => {
			const configId = await seedCodexSubscription();
			const release = await acquireCredentialLock(configId, { owner: HOLDER });
			const { manager, wsManager } = makeManager(ctx, replyingDocker());
			const { events } = captureCeoRoom(wsManager);

			const { assistantMessageId, conversationId } = await manager.sendTurn({ text: 'Hello CEO' });
			// The notice lands while the wait is still on - the same sentence a
			// waiting run writes to its log, with the holder linked the same way.
			await poll(async () => {
				const r = await ctx.db.query<{ content: string }>(
					`SELECT content FROM chat_messages WHERE conversation_id = $1 AND system_kind = $2`,
					[conversationId, ChatSystemMessageKind.CredentialWait],
				);
				return r.rows.length === 1;
			});
			const notice = await ctx.db.query<{ content: string }>(
				`SELECT content FROM chat_messages WHERE conversation_id = $1 AND system_kind = $2`,
				[conversationId, ChatSystemMessageKind.CredentialWait],
			);
			expect(notice.rows[0].content).toBe(
				`Waiting for ${HOLDER_TEXT} to finish with this credential.`,
			);
			expect(
				events.some(
					(e) =>
						e.type === WsMessageType.ChatMessageStart &&
						e.systemKind === ChatSystemMessageKind.CredentialWait,
				),
			).toBe(true);
			const midWait = await ctx.db.query<{ status: string }>(
				'SELECT status FROM chat_messages WHERE id = $1',
				[assistantMessageId],
			);
			expect(midWait.rows[0].status).not.toBe(ChatMessageStatus.Complete);

			release();
			await poll(async () => {
				const r = await ctx.db.query<{ status: string }>(
					'SELECT status FROM chat_messages WHERE id = $1',
					[assistantMessageId],
				);
				return r.rows[0]?.status === ChatMessageStatus.Complete;
			});
			await manager.stop();
		});

		test('goes ahead of runs merely parked on the credential', async () => {
			const configId = await seedCodexSubscription();
			const release = await acquireCredentialLock(configId, { owner: HOLDER });
			// A task run parked behind the holder, exactly as the runner parks one.
			const order: string[] = [];
			const parkedRun = acquireCredentialLock(configId, {
				owner: { label: 'ops/OP-1', link: null },
				timeoutMs: 10_000,
			}).then((rel) => {
				order.push('run');
				rel();
			});
			const docker = createStubDocker(
				{
					execCreate: async () => 'exec-codex-chat',
					execStart: async (
						_execId: string,
						opts: { onChunk?: (c: ExecLogChunk) => void | Promise<void> },
					) => {
						order.push('chat');
						const onChunk = opts.onChunk ?? (() => undefined);
						await onChunk({ stream: 'stdout', text: assistantText('Hello') });
						await onChunk({ stream: 'stdout', text: resultEvent(10, 5, 0.01) });
						return { stdout: '', stderr: '' };
					},
				},
				{ db: ctx.db, dataDir: ctx.dataDir },
			);
			const { manager } = makeManager(ctx, docker);
			const { assistantMessageId, conversationId } = await manager.sendTurn({ text: 'Hello CEO' });
			await poll(async () => {
				const r = await ctx.db.query(
					`SELECT 1 FROM chat_messages WHERE conversation_id = $1 AND system_kind = $2`,
					[conversationId, ChatSystemMessageKind.CredentialWait],
				);
				return r.rows.length === 1;
			});

			release();
			await poll(async () => {
				const r = await ctx.db.query<{ status: string }>(
					'SELECT status FROM chat_messages WHERE id = $1',
					[assistantMessageId],
				);
				return r.rows[0]?.status === ChatMessageStatus.Complete;
			});
			await parkedRun;
			// Every chat exec (the session's own probe, the reply, the title) lands
			// before the run that was queued first.
			expect(order.at(-1)).toBe('run');
			expect(order.filter((o) => o === 'chat').length).toBeGreaterThan(0);
			await manager.stop();
		});

		test('fails the turn naming the holder when the wait runs out, and tells the widget why', async () => {
			const configId = await seedCodexSubscription();
			const release = await acquireCredentialLock(configId, { owner: HOLDER });
			try {
				const { manager, wsManager } = makeManager(ctx, replyingDocker(), {
					capacityPark: { pollMs: 10, maxMs: 40 },
				});
				const { events } = captureCeoRoom(wsManager);
				const { assistantMessageId } = await manager.sendTurn({ text: 'Hello CEO' });
				await poll(async () => {
					const r = await ctx.db.query<{ status: string }>(
						'SELECT status FROM chat_messages WHERE id = $1',
						[assistantMessageId],
					);
					return r.rows[0]?.status === ChatMessageStatus.Failed;
				});
				const row = await ctx.db.query<{ error: string | null }>(
					'SELECT error FROM chat_messages WHERE id = $1',
					[assistantMessageId],
				);
				expect(row.rows[0].error).toBe(
					`${HOLDER_TEXT} is still using this provider credential; this subscription runs one agent at a time.`,
				);
				// The reason travels with the completion frame, so an open chatbox shows
				// it rather than a generic failure.
				const complete = events.find(
					(e) => e.type === WsMessageType.ChatMessageComplete && e.messageId === assistantMessageId,
				);
				expect(complete?.status).toBe(ChatMessageStatus.Failed);
				expect(complete?.error).toBe(row.rows[0].error);
				await manager.stop();
			} finally {
				release();
			}
		});

		test('runs on the credential the store holds once the lock is taken, not the one it mounted at start', async () => {
			const configId = await seedCodexSubscription();
			const key = ctx.masterKeyManager.getKey();
			if (!key) throw new Error('master key unavailable');
			const rotatedByRun = JSON.stringify({
				tokens: {
					id_token: 'header.payload.sig3',
					access_token: 'header.payload.sig3',
					refresh_token: 'rt-rotated-by-run',
					account_id: 'acct-1',
				},
			});

			let codexHome: string | null = null;
			const seen: string[] = [];
			const docker = createStubDocker(
				{
					execCreate: async (_id: string, config: { Env?: string[] }) => {
						const entry = (config.Env ?? []).find((e) => e.startsWith('CODEX_HOME='));
						if (entry) codexHome = entry.slice('CODEX_HOME='.length);
						return 'exec-codex-fresh';
					},
					execStart: async (
						_execId: string,
						opts: { onChunk?: (c: ExecLogChunk) => void | Promise<void> },
					) => {
						if (codexHome)
							seen.push(await docker.files('hq-container', codexHome).read('auth.json'));
						const onChunk = opts.onChunk ?? (() => undefined);
						await onChunk({ stream: 'stdout', text: assistantText('Hello') });
						await onChunk({ stream: 'stdout', text: resultEvent(10, 5, 0.01) });
						return { stdout: '', stderr: '' };
					},
				},
				{ db: ctx.db, dataDir: ctx.dataDir },
			);
			const { manager } = makeManager(ctx, docker);
			const first = await manager.sendTurn({ text: 'First' });
			// The reply and the auto-title both exec on this credential; wait for
			// both, so nothing from this turn can read the file after the rotation.
			await poll(async () => {
				const r = await ctx.db.query<{ status: string }>(
					'SELECT status FROM chat_messages WHERE id = $1',
					[first.assistantMessageId],
				);
				return r.rows[0]?.status === ChatMessageStatus.Complete && seen.length >= 2;
			});
			expect(seen).toEqual([ORIGINAL, ORIGINAL]);
			const execsBefore = seen.length;

			// A task run took the credential between turns and rotated it.
			await ctx.db.query('UPDATE ai_provider_configs SET encrypted_credential = $2 WHERE id = $1', [
				configId,
				encrypt(rotatedByRun, key),
			]);
			const second = await manager.sendTurn({ text: 'Second' });
			await poll(async () => {
				const r = await ctx.db.query<{ status: string }>(
					'SELECT status FROM chat_messages WHERE id = $1',
					[second.assistantMessageId],
				);
				return r.rows[0]?.status === ChatMessageStatus.Complete;
			});
			const after = seen.slice(execsBefore);
			expect(after.length).toBeGreaterThan(0);
			expect(after.every((v) => v === rotatedByRun)).toBe(true);
			// And nothing was written back over it: the file and the store agree.
			const stored = await ctx.db.query<{ encrypted_credential: string }>(
				'SELECT encrypted_credential FROM ai_provider_configs WHERE id = $1',
				[configId],
			);
			expect(decrypt(stored.rows[0].encrypted_credential, key)).toBe(rotatedByRun);
			await manager.stop();
		});
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
			{ crossProject: true, crossTeam: true },
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

	test('a worker-scoped session token carries no cross-project or cross-team power', async () => {
		// The claim matrix: worker/Captain chat sessions are bound to their own
		// project team. verifyToken must derive the scope from the payload - it
		// used to hardcode crossProject:true for every session principal, which
		// would have handed each worker DM the CEO's reach.
		const team = await ctx.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Growth', 'growth-auth-test') RETURNING id`,
		);
		const teamId = team.rows[0].id;
		const project = await ctx.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'Growth', 'growth-auth-test', 'GRW') RETURNING id`,
			[teamId],
		);
		const member = await ctx.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'Maya') RETURNING id`,
			[teamId],
		);
		const session = await ctx.db.query<{ id: string }>(
			`INSERT INTO chat_sessions (member_id, team_id, project_id, runtime_type, status)
			 VALUES ($1, $2, $3, 'claude_code', 'running') RETURNING id`,
			[member.rows[0].id, teamId, project.rows[0].id],
		);
		const token = await signChatSessionJwt(
			ctx.masterKeyManager,
			member.rows[0].id,
			teamId,
			session.rows[0].id,
			project.rows[0].id,
			{ crossProject: false, crossTeam: false, ttlSeconds: WORKER_SESSION_JWT_TTL_SECONDS },
		);

		const auth = await verifyToken(token, ctx.db, ctx.masterKeyManager);
		expect(auth?.type).toBe(AuthType.Agent);
		if (auth?.type !== AuthType.Agent) throw new Error('expected agent auth');
		expect(auth.crossProject).toBe(false);
		expect(auth.crossTeam).toBe(false);
		expect(auth.teamId).toBe(teamId);
		expect(auth.projectId).toBe(project.rows[0].id);

		// The team gate honours the scope: its own team yes, HQ no.
		expect(await canAuthAccessTeam(ctx.db, auth, teamId)).toBe(true);
		expect(await canAuthAccessTeam(ctx.db, auth, DEFAULT_TEAM_ID)).toBe(false);
	});
});
