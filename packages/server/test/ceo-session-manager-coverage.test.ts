import { CeoMessageStatus, CeoSessionStatus, DEFAULT_TEAM_ID } from '@hezo/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { encrypt } from '../src/crypto/encryption';
import { CeoSessionManager, formatChatMemoryBlock } from '../src/services/ceo-session-manager';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import { WebSocketManager } from '../src/services/ws';
import { createStubDocker } from './helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

function makeManager(ctx: ServerTestContext) {
	const wsManager = new WebSocketManager();
	const logs = new LogStreamBroker();
	logs.setWsManager(wsManager);
	const manager = new CeoSessionManager({
		db: ctx.db,
		docker: createStubDocker(),
		masterKeyManager: ctx.masterKeyManager,
		serverPort: 0,
		dataDir: ctx.dataDir,
		wsManager,
		logs,
	});
	return { manager, wsManager };
}

async function seedProvider(ctx: ServerTestContext): Promise<void> {
	const key = ctx.masterKeyManager.getKey();
	if (!key) throw new Error('master key unavailable');
	await ctx.db.query(
		`INSERT INTO ai_provider_configs (provider, auth_method, label, encrypted_credential, is_default, status, default_model)
		 VALUES ('anthropic', 'api_key', 'test', $1, true, 'active', 'claude-sonnet-4-6')`,
		[encrypt('sk-ant-test', key)],
	);
}

describe('formatChatMemoryBlock', () => {
	test('renders a placeholder when memory is empty/whitespace', () => {
		const block = formatChatMemoryBlock('   \n  ');
		expect(block).toContain('Chatbox memory');
		expect(block).toContain('_(nothing recorded yet)_');
	});

	test('renders trimmed content when memory is present', () => {
		const block = formatChatMemoryBlock('  Operator prefers brevity.  ');
		expect(block).toContain('Operator prefers brevity.');
		expect(block).not.toContain('_(nothing recorded yet)_');
	});
});

describe('CeoSessionManager lifecycle guards', () => {
	let ctx: ServerTestContext;

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
	});

	test('stop() is a no-op when never started (no health timer, no live session)', async () => {
		const { manager } = makeManager(ctx);
		await expect(manager.stop()).resolves.toBeUndefined();
	});

	test('start() is idempotent — a second call does not stack a second health timer', async () => {
		const { manager } = makeManager(ctx);
		manager.start();
		manager.start();
		await manager.stop();
	});

	test('restart() with no live session tears down to stopped without throwing', async () => {
		const { manager } = makeManager(ctx);
		await expect(manager.restart()).resolves.toBeUndefined();
		// No session row was created because there was nothing live.
		const sessions = await ctx.db.query<{ n: number }>(
			'SELECT COUNT(*)::int AS n FROM ceo_sessions',
		);
		expect(sessions.rows[0].n).toBe(0);
	});

	test('getConversationId creates the conversation on first call and reuses it after', async () => {
		const { manager } = makeManager(ctx);
		const first = await manager.getConversationId();
		expect(first).toBeTruthy();
		const second = await manager.getConversationId();
		expect(second).toBe(first);

		const rows = await ctx.db.query<{ n: number }>(
			'SELECT COUNT(*)::int AS n FROM ceo_conversations',
		);
		expect(rows.rows[0].n).toBe(1);
	});

	test('sendTurn fails the assistant message when no AI provider is configured', async () => {
		// No provider seeded: startSession throws "No AI provider credentials configured",
		// which the session-start catch records and the turn surfaces as a failed reply.
		const { manager } = makeManager(ctx);

		await expect(manager.sendTurn({ text: 'hello with no provider' })).rejects.toThrow();

		// No session row should have been left live.
		const live = await ctx.db.query<{ n: number }>(
			`SELECT COUNT(*)::int AS n FROM ceo_sessions WHERE status IN ($1, $2)`,
			[CeoSessionStatus.Starting, CeoSessionStatus.Running],
		);
		expect(live.rows[0].n).toBe(0);
	});

	test('reconcileOnStartup is safe with no rows present', async () => {
		const { manager } = makeManager(ctx);
		await expect(manager.reconcileOnStartup()).resolves.toBeUndefined();
	});

	test('reconcileOnStartup crashes a session and interrupts only the non-empty streaming message', async () => {
		await seedProvider(ctx);
		const { manager } = makeManager(ctx);
		const conversationId = await manager.getConversationId();

		const ceo = await ctx.db.query<{ id: string }>(
			`SELECT m.id FROM members m JOIN member_agents ma ON ma.id = m.id
			 WHERE ma.slug = 'ceo' AND m.team_id = $1`,
			[DEFAULT_TEAM_ID],
		);
		const project = await ctx.db.query<{ id: string }>(
			`SELECT id FROM projects WHERE team_id = $1 AND is_internal = true`,
			[DEFAULT_TEAM_ID],
		);
		const sessionRes = await ctx.db.query<{ id: string }>(
			`INSERT INTO ceo_sessions (member_id, team_id, project_id, runtime_type, status)
			 VALUES ($1, $2, $3, 'claude_code', 'starting') RETURNING id`,
			[ceo.rows[0].id, DEFAULT_TEAM_ID, project.rows[0].id],
		);

		const insert = async (status: string, content: string) => {
			const r = await ctx.db.query<{ id: string }>(
				`INSERT INTO ceo_messages (conversation_id, role, channel, status, content)
				 VALUES ($1, 'assistant'::ceo_message_role, 'web'::ceo_channel, $2::ceo_message_status, $3)
				 RETURNING id`,
				[conversationId, status, content],
			);
			return r.rows[0].id;
		};
		const emptyStreaming = await insert('streaming', '');
		const partialPending = await insert('pending', 'partial reply');

		await manager.reconcileOnStartup();

		const session = await ctx.db.query<{ status: string }>(
			'SELECT status FROM ceo_sessions WHERE id = $1',
			[sessionRes.rows[0].id],
		);
		expect(session.rows[0].status).toBe(CeoSessionStatus.Crashed);

		const remaining = await ctx.db.query<{ id: string; status: string }>(
			'SELECT id, status FROM ceo_messages',
		);
		const byId = new Map(remaining.rows.map((r) => [r.id, r.status]));
		expect(byId.has(emptyStreaming)).toBe(false);
		expect(byId.get(partialPending)).toBe(CeoMessageStatus.Interrupted);
	});
});
