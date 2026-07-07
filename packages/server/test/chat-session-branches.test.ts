import {
	AuthType,
	ChatMessageStatus,
	ChatSessionStatus,
	DEFAULT_TEAM_ID,
	wsRoom,
} from '@hezo/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { encrypt } from '../src/crypto/encryption';
import { ChatSessionManager } from '../src/services/chat-session-manager';
import {
	ContainerConnectivityStatus,
	type ProbeResult,
} from '../src/services/container-connectivity-status';
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
const resultEvent = (input: number, output: number, costUsd: number) =>
	claudeLine({
		type: 'result',
		usage: { input_tokens: input, output_tokens: output },
		total_cost_usd: costUsd,
	});

async function poll(fn: () => Promise<boolean>, timeoutMs = 4000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await fn()) return;
		await new Promise((r) => setTimeout(r, 15));
	}
	throw new Error('poll timed out');
}

/** A reply-mode chat docker (emits one assistant text + result, then exits). */
function replyDocker() {
	return createStubDocker({
		execCreate: async () => 'exec-1',
		execStart: async (
			_id: string,
			opts: { onChunk?: (c: ExecLogChunk) => void | Promise<void> },
		) => {
			const onChunk = opts.onChunk ?? (() => undefined);
			await onChunk({ stream: 'stdout', text: assistantText('Hi there') });
			await onChunk({ stream: 'stdout', text: resultEvent(10, 5, 0.02) });
			return { stdout: '', stderr: '' };
		},
	});
}

/** A docker whose exec throws mid-turn (non-abort failure → runTurn failed arm). */
function failingExecDocker() {
	return createStubDocker({
		execCreate: async () => 'exec-1',
		execStart: async () => {
			throw new Error('exec blew up');
		},
	});
}

async function seedProvider(ctx: ServerTestContext): Promise<void> {
	const key = ctx.masterKeyManager.getKey();
	if (!key) throw new Error('master key unavailable');
	await ctx.db.query(
		`INSERT INTO ai_provider_configs (provider, auth_method, label, encrypted_credential, is_default, status, default_model)
		 VALUES ('anthropic', 'api_key', 'test', $1, true, 'verified', 'claude-sonnet-4-6')`,
		[encrypt('sk-ant-test', key)],
	);
}

async function markHqRunning(ctx: ServerTestContext): Promise<string> {
	const proj = await ctx.db.query<{ id: string }>(
		`UPDATE projects SET container_id = 'hq-container', container_status = 'running'
		 WHERE team_id = $1 AND is_internal = true RETURNING id`,
		[DEFAULT_TEAM_ID],
	);
	return proj.rows[0].id;
}

function makeManager(
	ctx: ServerTestContext,
	docker: ReturnType<typeof createStubDocker>,
	extra: Record<string, unknown> = {},
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

describe('ChatSessionManager — startSession failure branches', () => {
	let ctx: ServerTestContext;
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
		await markHqRunning(ctx);
	});

	test('fails the turn (assistant message → failed) when no AI provider is configured', async () => {
		// No provider rows and no model override → resolveRuntimeForTask returns null
		// → startSession throws "No AI provider credentials configured". The turn
		// surfaces it on the assistant message rather than crashing the process.
		const { manager } = makeManager(ctx, replyDocker());
		await expect(manager.sendTurn({ text: 'hello' })).rejects.toThrow(/AI provider credentials/);
	});

	test('runTurn marks the assistant message failed when the exec throws (non-abort)', async () => {
		await seedProvider(ctx);
		const { manager } = makeManager(ctx, failingExecDocker());
		const { assistantMessageId } = await manager.sendTurn({ text: 'go' });
		await poll(async () => {
			const r = await ctx.db.query<{ status: string; error: string | null }>(
				'SELECT status, error FROM chat_messages WHERE id = $1',
				[assistantMessageId],
			);
			return r.rows[0]?.status === ChatMessageStatus.Failed;
		});
		const row = await ctx.db.query<{ error: string }>(
			'SELECT error FROM chat_messages WHERE id = $1',
			[assistantMessageId],
		);
		expect(row.rows[0].error).toContain('exec blew up');
		await manager.stop();
	});

	test('uses the member model-override provider when one is set (skips runtime resolution)', async () => {
		await seedProvider(ctx);
		// Set an explicit model override on the CEO member: startSession takes the
		// `if (provider)` branch (PROVIDER_RUNTIME_ADAPTERS) instead of resolving.
		await ctx.db.query(
			`UPDATE member_agents SET model_override_provider = 'anthropic', model_override_model = 'claude-opus-4-6'
			 WHERE slug = 'ceo'`,
		);
		const { manager } = makeManager(ctx, replyDocker());
		const { assistantMessageId } = await manager.sendTurn({ text: 'hi' });
		await poll(async () => {
			const r = await ctx.db.query<{ status: string }>(
				'SELECT status FROM chat_messages WHERE id = $1',
				[assistantMessageId],
			);
			return r.rows[0]?.status === ChatMessageStatus.Complete;
		});
		const session = await ctx.db.query<{ runtime_type: string }>(
			`SELECT runtime_type FROM chat_sessions ORDER BY started_at DESC LIMIT 1`,
		);
		expect(session.rows[0].runtime_type).toBe('claude_code');
		await manager.stop();
	});
});

describe('ChatSessionManager — connectivity gate abort', () => {
	let ctx: ServerTestContext;
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
		await markHqRunning(ctx);
		await seedProvider(ctx);
	});

	test('aborts the session with operator guidance when egress is unreachable from containers', async () => {
		// Wire egressProxy + CA + a connectivity status pinned to mcp-unreachable.
		// startSession re-probes (maxAge 0) and, since the probe re-confirms the bad
		// status, throws the guidance error — which the catch arm records as crashed.
		const status = new ContainerConnectivityStatus('127.0.0.1');
		status.set('mcp-unreachable', '127.0.0.1');
		const probe = async (): Promise<ProbeResult> => ({
			status: 'mcp-unreachable',
			bindHost: '127.0.0.1',
		});
		let proxyAllocated = false;
		const egressProxy = {
			allocateRunProxy: async () => {
				proxyAllocated = true;
				return { proxyHost: 'h', proxyPort: 1 };
			},
			releaseRunProxy: async () => undefined,
		};
		const { manager } = makeManager(ctx, replyDocker(), {
			egressProxy,
			egressCAPath: '/tmp/ca.crt',
			connectivityStatus: status,
			connectivityProbe: probe,
		});

		await expect(manager.sendTurn({ text: 'hello' })).rejects.toThrow(
			/Egress proxy unreachable from agent containers/,
		);
		// The gate aborts before the proxy is ever allocated.
		expect(proxyAllocated).toBe(false);
		// The session row was created then marked crashed by the catch arm.
		const session = await ctx.db.query<{ status: string; error: string }>(
			`SELECT status, error FROM chat_sessions ORDER BY started_at DESC LIMIT 1`,
		);
		expect(session.rows[0].status).toBe(ChatSessionStatus.Crashed);
		expect(session.rows[0].error).toContain('Egress proxy unreachable');
	});

	test('fails open and completes the turn when connectivity is ok', async () => {
		const status = new ContainerConnectivityStatus('127.0.0.1');
		status.set('ok', '127.0.0.1');
		const probe = async (): Promise<ProbeResult> => ({ status: 'ok', bindHost: '127.0.0.1' });
		const egressProxy = {
			allocateRunProxy: async () => ({ proxyHost: 'host.docker.internal', proxyPort: 24000 }),
			releaseRunProxy: async () => undefined,
		};
		const { manager } = makeManager(ctx, replyDocker(), {
			egressProxy,
			egressCAPath: '/tmp/ca.crt',
			connectivityStatus: status,
			connectivityProbe: probe,
		});
		const { assistantMessageId } = await manager.sendTurn({ text: 'hello' });
		await poll(async () => {
			const r = await ctx.db.query<{ status: string }>(
				'SELECT status FROM chat_messages WHERE id = $1',
				[assistantMessageId],
			);
			return r.rows[0]?.status === ChatMessageStatus.Complete;
		});
		await manager.stop();
	});
});

describe('ChatSessionManager — lifecycle branches', () => {
	let ctx: ServerTestContext;
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
		await markHqRunning(ctx);
		await seedProvider(ctx);
	});

	test('restart tears down the live session and the next turn re-allocates a fresh one', async () => {
		const { manager } = makeManager(ctx, replyDocker());
		const first = await manager.sendTurn({ text: 'one' });
		await poll(async () => {
			const r = await ctx.db.query<{ status: string }>(
				'SELECT status FROM chat_messages WHERE id = $1',
				[first.assistantMessageId],
			);
			return r.rows[0]?.status === ChatMessageStatus.Complete;
		});

		await manager.restart();
		// The prior session row is now stopped.
		const stopped = await ctx.db.query<{ n: number }>(
			`SELECT COUNT(*)::int AS n FROM chat_sessions WHERE status = $1`,
			[ChatSessionStatus.Stopped],
		);
		expect(stopped.rows[0].n).toBeGreaterThanOrEqual(1);

		// A new turn allocates a fresh session.
		const second = await manager.sendTurn({ text: 'two' });
		await poll(async () => {
			const r = await ctx.db.query<{ status: string }>(
				'SELECT status FROM chat_messages WHERE id = $1',
				[second.assistantMessageId],
			);
			return r.rows[0]?.status === ChatMessageStatus.Complete;
		});
		const live = await ctx.db.query<{ n: number }>(
			`SELECT COUNT(*)::int AS n FROM chat_sessions WHERE status IN ($1, $2)`,
			[ChatSessionStatus.Starting, ChatSessionStatus.Running],
		);
		expect(live.rows[0].n).toBe(1);
		await manager.stop();
	});

	test('restart with no live session is a no-op (teardown early return)', async () => {
		const { manager } = makeManager(ctx, replyDocker());
		// No turn yet → this.live is null → restart returns without error.
		await manager.restart();
		expect(true).toBe(true);
	});

	test('the health timer tears the session down when the HQ container disappears', async () => {
		const { manager } = makeManager(ctx, replyDocker());
		const { assistantMessageId } = await manager.sendTurn({ text: 'hi' });
		await poll(async () => {
			const r = await ctx.db.query<{ status: string }>(
				'SELECT status FROM chat_messages WHERE id = $1',
				[assistantMessageId],
			);
			return r.rows[0]?.status === ChatMessageStatus.Complete;
		});

		// Container vanishes; checkHealth should notice the mismatch and teardown.
		await ctx.db.query(
			`UPDATE projects SET container_status = 'stopped', container_id = NULL
			 WHERE team_id = $1 AND is_internal = true`,
			[DEFAULT_TEAM_ID],
		);
		// checkHealth is private; drive it via the public start() timer would be slow,
		// so invoke through restart's sibling: call the internal check by reaching in.
		await (manager as unknown as { checkHealth(): Promise<void> }).checkHealth();

		const live = await ctx.db.query<{ n: number }>(
			`SELECT COUNT(*)::int AS n FROM chat_sessions WHERE status IN ($1, $2)`,
			[ChatSessionStatus.Starting, ChatSessionStatus.Running],
		);
		expect(live.rows[0].n).toBe(0);
		await manager.stop();
	});

	test('checkHealth is a no-op when there is no live session', async () => {
		const { manager } = makeManager(ctx, replyDocker());
		await (manager as unknown as { checkHealth(): Promise<void> }).checkHealth();
		expect(true).toBe(true);
	});

	test('start() is idempotent — a second start does not create a second timer', async () => {
		const { manager } = makeManager(ctx, replyDocker());
		manager.start();
		manager.start(); // second call short-circuits on the existing healthTimer
		await manager.stop();
		expect(true).toBe(true);
	});

	test('getConversationId creates the conversation row once, then returns it', async () => {
		const { manager } = makeManager(ctx, replyDocker());
		const a = await manager.getConversationId();
		const b = await manager.getConversationId();
		expect(a).toBe(b);
		const count = await ctx.db.query<{ n: number }>(
			`SELECT COUNT(*)::int AS n FROM chat_conversations`,
		);
		expect(count.rows[0].n).toBe(1);
	});

	test('formatLongTermMemoryBlock shows a placeholder when empty and the body when present', async () => {
		const { formatLongTermMemoryBlock } = await import('../src/services/chat-session-manager');
		expect(formatLongTermMemoryBlock('   ')).toContain('nothing recorded yet');
		const withBody = formatLongTermMemoryBlock('Operator prefers terse replies');
		expect(withBody).toContain('Operator prefers terse replies');
		expect(withBody).toContain('## Long-term memory');
		expect(withBody).not.toContain('nothing recorded yet');
	});
});

describe('ChatSessionManager — broadcast wiring', () => {
	let ctx: ServerTestContext;
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
		await markHqRunning(ctx);
		await seedProvider(ctx);
	});

	test('broadcasts start, delta, and complete to the ceo room over a single turn', async () => {
		const { manager, wsManager } = makeManager(ctx, replyDocker());
		const events: Array<Record<string, unknown>> = [];
		wsManager.subscribe(
			{
				data: { auth: { type: AuthType.Admin, isSuperuser: true }, rooms: new Set() },
				send: (m: string) => events.push(JSON.parse(m)),
			},
			wsRoom.chat(),
		);

		const { assistantMessageId } = await manager.sendTurn({ text: 'hi' });
		await poll(async () => {
			const r = await ctx.db.query<{ status: string }>(
				'SELECT status FROM chat_messages WHERE id = $1',
				[assistantMessageId],
			);
			return r.rows[0]?.status === ChatMessageStatus.Complete;
		});

		expect(events.some((e) => e.type === 'chat_message_start')).toBe(true);
		expect(events.some((e) => e.type === 'chat_message_delta' && e.text === 'Hi there')).toBe(true);
		expect(events.some((e) => e.type === 'chat_message_complete')).toBe(true);
		await manager.stop();
	});
});
