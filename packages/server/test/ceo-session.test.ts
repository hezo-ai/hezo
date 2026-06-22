import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	AuthType,
	CeoMessageStatus,
	CeoSessionStatus,
	DEFAULT_TEAM_ID,
	wsRoom,
} from '@hezo/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { encrypt } from '../src/crypto/encryption';
import { signCeoSessionJwt, verifyToken } from '../src/middleware/auth';
import { CeoSessionManager } from '../src/services/ceo-session-manager';
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

function captureCeoRoom(wsManager: WebSocketManager): { events: Array<Record<string, unknown>> } {
	const events: Array<Record<string, unknown>> = [];
	const socket: WsSocket = {
		data: { auth: { type: AuthType.Admin, isSuperuser: true }, rooms: new Set() },
		send: (msg: string) => events.push(JSON.parse(msg)),
	};
	wsManager.subscribe(socket, wsRoom.ceo());
	return { events };
}

async function seedProviderAndContainer(ctx: ServerTestContext): Promise<string> {
	const key = ctx.masterKeyManager.getKey();
	if (!key) throw new Error('master key unavailable');
	await ctx.db.query(
		`INSERT INTO ai_provider_configs (provider, auth_method, label, encrypted_credential, is_default, status, default_model)
		 VALUES ('anthropic', 'api_key', 'test', $1, true, 'active', 'claude-sonnet-4-6')`,
		[encrypt('sk-ant-test', key)],
	);
	const proj = await ctx.db.query<{ id: string }>(
		`UPDATE projects SET container_id = 'hq-container', container_status = 'running'
		 WHERE team_id = $1 AND is_internal = true RETURNING id`,
		[DEFAULT_TEAM_ID],
	);
	return proj.rows[0].id;
}

function makeManager(ctx: ServerTestContext, docker: ReturnType<typeof createStubDocker>) {
	const wsManager = new WebSocketManager();
	const logs = new LogStreamBroker();
	logs.setWsManager(wsManager);
	const manager = new CeoSessionManager({
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

describe('CeoSessionManager', () => {
	let ctx: ServerTestContext;
	let projectId: string;

	beforeAll(async () => {
		ctx = await createTestContext();
	});
	afterAll(async () => {
		await destroyTestContext(ctx);
	});
	beforeEach(async () => {
		await ctx.db.query('DELETE FROM ceo_messages');
		await ctx.db.query('DELETE FROM ceo_sessions');
		await ctx.db.query('DELETE FROM ceo_conversations');
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
				'SELECT status FROM ceo_messages WHERE id = $1',
				[assistantMessageId],
			);
			return r.rows[0]?.status === CeoMessageStatus.Complete;
		});

		const asst = await ctx.db.query<{
			content: string;
			input_tokens: number;
			output_tokens: number;
		}>('SELECT content, input_tokens, output_tokens FROM ceo_messages WHERE id = $1', [
			assistantMessageId,
		]);
		expect(asst.rows[0].content).toBe('Hi there');
		expect(Number(asst.rows[0].input_tokens)).toBe(10);
		expect(Number(asst.rows[0].output_tokens)).toBe(5);

		const user = await ctx.db.query<{ role: string; content: string }>(
			'SELECT role, content FROM ceo_messages WHERE id = $1',
			[userMessageId],
		);
		expect(user.rows[0].content).toBe('Hello CEO');

		const deltas = captured.events.filter((e) => e.type === 'ceo_message_delta');
		expect(deltas.some((d) => d.text === 'Hi there')).toBe(true);
		expect(captured.events.some((e) => e.type === 'ceo_message_complete')).toBe(true);

		await manager.stop();
	});

	test('second turn composes prior history into the prompt', async () => {
		const chat = makeChatDocker(ctx.dataDir, projectId);
		const { manager } = makeManager(ctx, chat.docker);

		const first = await manager.sendTurn({ text: 'What is the status?' });
		await poll(async () => {
			const r = await ctx.db.query<{ status: string }>(
				'SELECT status FROM ceo_messages WHERE id = $1',
				[first.assistantMessageId],
			);
			return r.rows[0]?.status === CeoMessageStatus.Complete;
		});

		await manager.sendTurn({ text: 'And the next step?' });
		await poll(async () => chat.prompts.length >= 2);

		const secondPrompt = chat.prompts[1];
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
		await poll(async () => chat.prompts.length >= 1);

		const prompt = chat.prompts[0];
		// Persist operator-facing deliverables to an assets library and link them,
		// instead of dropping a loose /workspace file the operator can't reach.
		expect(prompt).toContain('write_project_asset');
		expect(prompt).toContain('assets/<filename>');
		// Scope the deliverable to the relevant project, not HQ by default.
		expect(prompt).toContain('the project the work belongs to');
		// Off-project conversations get a rough summary in chat memory (they live
		// nowhere else once the window scrolls).
		expect(prompt).toContain('Summarize off-project conversations');

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
				'SELECT status FROM ceo_messages WHERE id = $1',
				[first.assistantMessageId],
			);
			return r.rows[0]?.status === CeoMessageStatus.Interrupted;
		});
		await poll(async () => {
			const r = await ctx.db.query<{ status: string }>(
				'SELECT status FROM ceo_messages WHERE id = $1',
				[second.assistantMessageId],
			);
			return r.rows[0]?.status === CeoMessageStatus.Complete;
		});

		await manager.stop();
	});

	test('ensureSession is idempotent (one live session per CEO)', async () => {
		const chat = makeChatDocker(ctx.dataDir, projectId);
		const { manager } = makeManager(ctx, chat.docker);

		const a = await manager.sendTurn({ text: 'one' });
		await poll(async () => {
			const r = await ctx.db.query<{ status: string }>(
				'SELECT status FROM ceo_messages WHERE id = $1',
				[a.assistantMessageId],
			);
			return r.rows[0]?.status === CeoMessageStatus.Complete;
		});
		await manager.sendTurn({ text: 'two' });

		const live = await ctx.db.query<{ n: number }>(
			`SELECT COUNT(*)::int AS n FROM ceo_sessions WHERE status IN ($1, $2)`,
			[CeoSessionStatus.Starting, CeoSessionStatus.Running],
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
			`INSERT INTO ceo_sessions (member_id, team_id, project_id, runtime_type, status)
			 VALUES ($1, $2, $3, 'claude_code', 'running')`,
			[ceo.rows[0].id, DEFAULT_TEAM_ID, projectId],
		);
		const { manager } = makeManager(ctx, makeChatDocker(ctx.dataDir, projectId).docker);
		await manager.reconcileOnStartup();
		const r = await ctx.db.query<{ status: string }>('SELECT status FROM ceo_sessions LIMIT 1');
		expect(r.rows[0].status).toBe(CeoSessionStatus.Crashed);
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
			`INSERT INTO ceo_sessions (member_id, team_id, project_id, runtime_type, status)
			 VALUES ($1, $2, $3, 'claude_code', 'running') RETURNING id`,
			[ceo.rows[0].id, DEFAULT_TEAM_ID, project.rows[0].id],
		);
		const sessionId = session.rows[0].id;
		const token = await signCeoSessionJwt(
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

		await ctx.db.query(`UPDATE ceo_sessions SET status = 'stopped' WHERE id = $1`, [sessionId]);
		const denied = await verifyToken(token, ctx.db, ctx.masterKeyManager);
		expect(denied).toBeNull();
	});
});
