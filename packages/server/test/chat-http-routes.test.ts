import {
	ChatChannel,
	ChatMessageRole,
	ChatMessageStatus,
	ChatSessionStatus,
	DEFAULT_TEAM_ID,
} from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { encrypt } from '../src/crypto/encryption';
import type { Env } from '../src/lib/types';
import { signAdminJwt, signChatSessionJwt } from '../src/middleware/auth';
import { ChatSessionManager } from '../src/services/chat-session-manager';
import type { ExecLogChunk } from '../src/services/docker';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import { WebSocketManager } from '../src/services/ws';
import { buildApp } from '../src/startup';
import { authHeader, createStubDocker, createTestApp, seedProjectContainer } from './helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

const claudeLine = (obj: unknown) => `${JSON.stringify(obj)}\n`;
const assistantText = (text: string) =>
	claudeLine({
		type: 'assistant',
		message: { role: 'assistant', content: [{ type: 'text', text }] },
	});
const resultEvent = (input: number, output: number) =>
	claudeLine({ type: 'result', usage: { input_tokens: input, output_tokens: output } });

async function poll(fn: () => Promise<boolean>, timeoutMs = 4000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await fn()) return;
		await new Promise((r) => setTimeout(r, 15));
	}
	throw new Error('poll timed out');
}

/** Docker stub that replies to any prompt-bearing exec with one text + result frame. */
function replyDocker() {
	return createStubDocker({
		execCreate: async () => 'exec-1',
		execStart: async (
			_id: string,
			opts: { onChunk?: (c: ExecLogChunk) => void | Promise<void> } = {},
		) => {
			const onChunk = opts.onChunk ?? (() => undefined);
			await onChunk({ stream: 'stdout', text: assistantText('Hi there') });
			await onChunk({ stream: 'stdout', text: resultEvent(10, 5) });
			return { stdout: '', stderr: '' };
		},
	});
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
	await seedProjectContainer(ctx.db, proj.rows[0].id, 'hq-container');
	return proj.rows[0].id;
}

describe('CEO chat HTTP routes', () => {
	let ctx: ServerTestContext;
	let hqProjectId: string;
	let manager: ChatSessionManager;
	/** A second app over the same db/state, with the CEO session manager wired in. */
	let app: Hono<Env>;

	beforeAll(async () => {
		ctx = await createTestContext();
	});
	afterAll(async () => {
		await destroyTestContext(ctx);
	});
	beforeEach(async () => {
		await ctx.db.query('DELETE FROM chat_memories');
		await ctx.db.query('DELETE FROM chat_messages');
		await ctx.db.query('DELETE FROM chat_sessions');
		await ctx.db.query('DELETE FROM chat_conversations');
		await ctx.db.query('DELETE FROM ai_provider_configs');
		hqProjectId = await seedProviderAndContainer(ctx);

		const docker = replyDocker();
		const wsManager = new WebSocketManager();
		const logs = new LogStreamBroker();
		manager = new ChatSessionManager({
			db: ctx.db,
			docker,
			masterKeyManager: ctx.masterKeyManager,
			serverPort: 0,
			dataDir: ctx.dataDir,
			wsManager,
			logs,
		});
		app = buildApp(
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
	});
	afterEach(async () => {
		await manager.stop();
	});

	async function seedMessage(input: {
		conversationId: string;
		role?: string;
		content: string;
		status?: string;
		compacted?: boolean;
		createdAt?: string;
	}): Promise<string> {
		const r = await ctx.db.query<{ id: string }>(
			`INSERT INTO chat_messages (conversation_id, role, channel, status, content, compacted_at, created_at, completed_at)
			 VALUES ($1, $2::chat_message_role, 'web'::chat_channel, $3::chat_message_status, $4,
			         ${input.compacted ? 'now()' : 'NULL'},
			         ${input.createdAt ? '$5::timestamptz' : 'now()'}, now())
			 RETURNING id`,
			input.createdAt
				? [
						input.conversationId,
						input.role ?? ChatMessageRole.User,
						input.status ?? ChatMessageStatus.Complete,
						input.content,
						input.createdAt,
					]
				: [
						input.conversationId,
						input.role ?? ChatMessageRole.User,
						input.status ?? ChatMessageStatus.Complete,
						input.content,
					],
		);
		return r.rows[0].id;
	}

	describe('when no ChatSessionManager is wired', () => {
		// The stock test app now carries a real manager; build one explicitly
		// without it to reproduce the pre-init state → every CEO chat endpoint
		// reports 503 UNAVAILABLE rather than crashing.
		test('all four endpoints return 503 UNAVAILABLE', async () => {
			const bare = await createTestApp({ chat: false });
			const h = { ...authHeader(bare.token), 'Content-Type': 'application/json' };
			const conv = await bare.app.request('/api/chat/conversation', { headers: h });
			expect(conv.status).toBe(503);
			expect((await conv.json()).error.code).toBe('UNAVAILABLE');

			const msgs = await bare.app.request('/api/chat/messages', { headers: h });
			expect(msgs.status).toBe(503);
			expect((await msgs.json()).error.code).toBe('UNAVAILABLE');

			const post = await bare.app.request('/api/chat/messages', {
				method: 'POST',
				headers: h,
				body: JSON.stringify({ text: 'hello' }),
			});
			expect(post.status).toBe(503);
			expect((await post.json()).error.code).toBe('UNAVAILABLE');

			const restart = await bare.app.request('/api/chat/session/restart', {
				method: 'POST',
				headers: h,
			});
			expect(restart.status).toBe(503);
			expect((await restart.json()).error.code).toBe('UNAVAILABLE');
		});
	});

	describe('authorization', () => {
		test('a non-superuser user outside HQ is denied on every endpoint', async () => {
			const user = await ctx.db.query<{ id: string }>(
				`INSERT INTO users (display_name, is_superuser) VALUES ('Outsider', false) RETURNING id`,
			);
			const token = await signAdminJwt(ctx.masterKeyManager, user.rows[0].id);
			const h = { ...authHeader(token), 'Content-Type': 'application/json' };

			const conv = await app.request('/api/chat/conversation', { headers: h });
			expect(conv.status).toBe(403);

			const msgs = await app.request('/api/chat/messages', { headers: h });
			expect(msgs.status).toBe(403);

			const post = await app.request('/api/chat/messages', {
				method: 'POST',
				headers: h,
				body: JSON.stringify({ text: 'hello' }),
			});
			expect(post.status).toBe(403);

			// restart is admin-equivalent-only: a plain (non-superuser) user is rejected
			// by requireAdminEquivalent before the manager is even consulted.
			const restart = await app.request('/api/chat/session/restart', {
				method: 'POST',
				headers: h,
			});
			expect(restart.status).toBe(403);
			expect((await restart.json()).error.code).toBe('FORBIDDEN');
			// No session was ever touched.
			const sessions = await ctx.db.query<{ n: number }>(
				'SELECT COUNT(*)::int AS n FROM chat_sessions',
			);
			expect(sessions.rows[0].n).toBe(0);
		});
	});

	describe('GET /api/chat/conversation', () => {
		test('returns the active window plus the compacted count', async () => {
			const conversationId = await manager.getConversationId();
			await seedMessage({
				conversationId,
				content: 'older, compacted away',
				compacted: true,
				createdAt: '2026-01-01T00:00:00Z',
			});
			await seedMessage({
				conversationId,
				content: 'first active',
				createdAt: '2026-01-02T00:00:00Z',
			});
			await seedMessage({
				conversationId,
				role: ChatMessageRole.Assistant,
				content: 'second active',
				createdAt: '2026-01-03T00:00:00Z',
			});

			const res = await app.request('/api/chat/conversation', { headers: authHeader(ctx.token) });
			expect(res.status).toBe(200);
			const body = (await res.json()).data;
			expect(body.conversation_id).toBe(conversationId);
			expect(body.compacted_count).toBe(1);
			expect(body.messages.map((m: { content: string }) => m.content)).toEqual([
				'first active',
				'second active',
			]);
			expect(body.messages[1].role).toBe('assistant');
		});

		test('creates the conversation on first use and returns an empty window', async () => {
			const res = await app.request('/api/chat/conversation', { headers: authHeader(ctx.token) });
			expect(res.status).toBe(200);
			const body = (await res.json()).data;
			expect(body.conversation_id).toBeTruthy();
			expect(body.messages).toEqual([]);
			expect(body.compacted_count).toBe(0);
			const rows = await ctx.db.query<{ n: number }>(
				'SELECT COUNT(*)::int AS n FROM chat_conversations',
			);
			expect(rows.rows[0].n).toBe(1);
		});
	});

	describe('GET /api/chat/messages', () => {
		let conversationId: string;
		beforeEach(async () => {
			conversationId = await manager.getConversationId();
			for (let i = 1; i <= 5; i++) {
				await seedMessage({
					conversationId,
					content: `msg-${i}`,
					createdAt: `2026-01-0${i}T00:00:00Z`,
				});
			}
		});

		test('returns the newest messages in ascending order, capped by limit', async () => {
			const res = await app.request('/api/chat/messages?limit=2', {
				headers: authHeader(ctx.token),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()).data;
			// Newest two, re-reversed to chronological order.
			expect(body.messages.map((m: { content: string }) => m.content)).toEqual(['msg-4', 'msg-5']);
		});

		test('pages older messages with before', async () => {
			const res = await app.request(
				`/api/chat/messages?before=${encodeURIComponent('2026-01-03T00:00:00Z')}&limit=10`,
				{ headers: authHeader(ctx.token) },
			);
			expect(res.status).toBe(200);
			const body = (await res.json()).data;
			expect(body.messages.map((m: { content: string }) => m.content)).toEqual(['msg-1', 'msg-2']);
		});

		test('clamps invalid and oversized limits', async () => {
			// Non-numeric → default 100 → all five.
			const bad = await app.request('/api/chat/messages?limit=abc', {
				headers: authHeader(ctx.token),
			});
			expect(((await bad.json()) as { data: { messages: unknown[] } }).data.messages.length).toBe(
				5,
			);
			// Zero/negative → default 100.
			const zero = await app.request('/api/chat/messages?limit=0', {
				headers: authHeader(ctx.token),
			});
			expect(((await zero.json()) as { data: { messages: unknown[] } }).data.messages.length).toBe(
				5,
			);
			// Oversized → clamped to 200 (still returns all five).
			const big = await app.request('/api/chat/messages?limit=99999', {
				headers: authHeader(ctx.token),
			});
			expect(((await big.json()) as { data: { messages: unknown[] } }).data.messages.length).toBe(
				5,
			);
		});
	});

	describe('POST /api/chat/messages', () => {
		test('rejects a missing, non-string, or blank text body', async () => {
			const h = { ...authHeader(ctx.token), 'Content-Type': 'application/json' };
			const missing = await app.request('/api/chat/messages', {
				method: 'POST',
				headers: h,
				body: JSON.stringify({}),
			});
			expect(missing.status).toBe(400);
			expect((await missing.json()).error.code).toBe('BAD_REQUEST');

			const nonString = await app.request('/api/chat/messages', {
				method: 'POST',
				headers: h,
				body: JSON.stringify({ text: 42 }),
			});
			expect(nonString.status).toBe(400);

			const blank = await app.request('/api/chat/messages', {
				method: 'POST',
				headers: h,
				body: JSON.stringify({ text: '   ' }),
			});
			expect(blank.status).toBe(400);

			// Malformed JSON falls into the .catch(() => ({})) arm → same 400.
			const invalid = await app.request('/api/chat/messages', {
				method: 'POST',
				headers: h,
				body: 'not json{{',
			});
			expect(invalid.status).toBe(400);

			// No message row was persisted by any of the rejects.
			const rows = await ctx.db.query<{ n: number }>(
				'SELECT COUNT(*)::int AS n FROM chat_messages',
			);
			expect(rows.rows[0].n).toBe(0);
		});

		test('persists the user message (attributed to the admin) and streams a reply', async () => {
			const res = await app.request('/api/chat/messages', {
				method: 'POST',
				headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ text: '  Hello CEO  ' }),
			});
			expect(res.status).toBe(201);
			const body = (await res.json()).data;
			expect(body.user_message_id).toBeTruthy();
			expect(body.assistant_message_id).toBeTruthy();

			const admin = await ctx.db.query<{ id: string }>(
				'SELECT id FROM users WHERE is_superuser = true ORDER BY created_at LIMIT 1',
			);
			const user = await ctx.db.query<{
				content: string;
				author_user_id: string | null;
				channel: string;
			}>('SELECT content, author_user_id, channel FROM chat_messages WHERE id = $1', [
				body.user_message_id,
			]);
			// Trimmed, web-channel, attributed to the posting admin.
			expect(user.rows[0].content).toBe('Hello CEO');
			expect(user.rows[0].author_user_id).toBe(admin.rows[0].id);
			expect(user.rows[0].channel).toBe(ChatChannel.Web);

			await poll(async () => {
				const r = await ctx.db.query<{ status: string }>(
					'SELECT status FROM chat_messages WHERE id = $1',
					[body.assistant_message_id],
				);
				return r.rows[0]?.status === ChatMessageStatus.Complete;
			});
			const asst = await ctx.db.query<{ content: string }>(
				'SELECT content FROM chat_messages WHERE id = $1',
				[body.assistant_message_id],
			);
			expect(asst.rows[0].content).toBe('Hi there');
		});

		test('an agent principal (CEO session token) posts without a user attribution', async () => {
			const ceo = await ctx.db.query<{ id: string }>(
				`SELECT m.id FROM members m JOIN member_agents ma ON ma.id = m.id
				 WHERE ma.slug = 'ceo' AND m.team_id = $1`,
				[DEFAULT_TEAM_ID],
			);
			const session = await ctx.db.query<{ id: string }>(
				`INSERT INTO chat_sessions (member_id, team_id, project_id, runtime_type, status)
				 VALUES ($1, $2, $3, 'claude_code', 'running') RETURNING id`,
				[ceo.rows[0].id, DEFAULT_TEAM_ID, hqProjectId],
			);
			const token = await signChatSessionJwt(
				ctx.masterKeyManager,
				ceo.rows[0].id,
				DEFAULT_TEAM_ID,
				session.rows[0].id,
				hqProjectId,
			);

			const res = await app.request('/api/chat/messages', {
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ text: 'from an agent' }),
			});
			expect(res.status).toBe(201);
			const body = (await res.json()).data;
			const user = await ctx.db.query<{ author_user_id: string | null }>(
				'SELECT author_user_id FROM chat_messages WHERE id = $1',
				[body.user_message_id],
			);
			expect(user.rows[0].author_user_id).toBeNull();
			await poll(async () => {
				const r = await ctx.db.query<{ status: string }>(
					'SELECT status FROM chat_messages WHERE id = $1',
					[body.assistant_message_id],
				);
				return r.rows[0]?.status === ChatMessageStatus.Complete;
			});
		});

		test('returns 503 CEO_UNAVAILABLE when the turn cannot start', async () => {
			// No provider configured → startSession throws → route maps it to 503.
			await ctx.db.query('DELETE FROM ai_provider_configs');
			const res = await app.request('/api/chat/messages', {
				method: 'POST',
				headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ text: 'hello' }),
			});
			expect(res.status).toBe(503);
			const body = await res.json();
			expect(body.error.code).toBe('CEO_UNAVAILABLE');
			expect(body.error.message).toContain('AI provider');
		});
	});

	describe('POST /api/chat/session/restart', () => {
		test('stops the live session; the next turn allocates a fresh one', async () => {
			const first = await app.request('/api/chat/messages', {
				method: 'POST',
				headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ text: 'boot the session' }),
			});
			expect(first.status).toBe(201);
			const firstBody = (await first.json()).data;
			await poll(async () => {
				const r = await ctx.db.query<{ status: string }>(
					'SELECT status FROM chat_messages WHERE id = $1',
					[firstBody.assistant_message_id],
				);
				return r.rows[0]?.status === ChatMessageStatus.Complete;
			});

			const res = await app.request('/api/chat/session/restart', {
				method: 'POST',
				headers: authHeader(ctx.token),
			});
			expect(res.status).toBe(200);
			expect((await res.json()).data.restarted).toBe(true);

			const live = await ctx.db.query<{ n: number }>(
				`SELECT COUNT(*)::int AS n FROM chat_sessions WHERE status IN ($1, $2)`,
				[ChatSessionStatus.Starting, ChatSessionStatus.Running],
			);
			expect(live.rows[0].n).toBe(0);
			const stopped = await ctx.db.query<{ n: number }>(
				`SELECT COUNT(*)::int AS n FROM chat_sessions WHERE status = $1`,
				[ChatSessionStatus.Stopped],
			);
			expect(stopped.rows[0].n).toBe(1);
		});
	});

	describe('file uploads', () => {
		async function uploadFile(name = 'diagram.png'): Promise<{
			id: string;
			original_filename: string;
			url: string;
		}> {
			const fd = new FormData();
			fd.set('file', new File([new Uint8Array([1, 2, 3, 4])], name, { type: 'image/png' }));
			const res = await app.request('/api/chat/assets', {
				method: 'POST',
				headers: authHeader(ctx.token),
				body: fd,
			});
			expect(res.status).toBe(201);
			return (await res.json()).data;
		}

		test('POST /chat/assets stores the file under uploads/chat in the HQ project', async () => {
			const asset = await uploadFile();
			expect(asset.original_filename).toBe('uploads/chat/diagram.png');
			expect(typeof asset.url).toBe('string');
			const row = await ctx.db.query<{ project_id: string }>(
				'SELECT project_id FROM assets WHERE id = $1',
				[asset.id],
			);
			expect(row.rows[0].project_id).toBe(hqProjectId);
		});

		test('a message with attachment_ids links them and returns them on the conversation', async () => {
			const asset = await uploadFile('shot.png');
			const res = await app.request('/api/chat/messages', {
				method: 'POST',
				headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ text: 'here it is', attachment_ids: [asset.id] }),
			});
			expect(res.status).toBe(201);
			const userMessageId = (await res.json()).data.user_message_id;

			const link = await ctx.db.query<{ n: number }>(
				'SELECT COUNT(*)::int AS n FROM chat_message_attachments WHERE chat_message_id = $1 AND asset_id = $2',
				[userMessageId, asset.id],
			);
			expect(link.rows[0].n).toBe(1);

			const convo = await app.request('/api/chat/conversation', { headers: authHeader(ctx.token) });
			const messages = (await convo.json()).data.messages as Array<{
				id: string;
				attachments: Array<{ id: string; url: string }>;
			}>;
			const sent = messages.find((m) => m.id === userMessageId);
			expect(sent?.attachments).toHaveLength(1);
			expect(sent?.attachments[0].id).toBe(asset.id);
			expect(typeof sent?.attachments[0].url).toBe('string');
		});

		test('accepts an attachment-only message (no text)', async () => {
			const asset = await uploadFile('only.png');
			const res = await app.request('/api/chat/messages', {
				method: 'POST',
				headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ text: '', attachment_ids: [asset.id] }),
			});
			expect(res.status).toBe(201);
		});

		test('rejects attachment_ids that are not HQ assets', async () => {
			const res = await app.request('/api/chat/messages', {
				method: 'POST',
				headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
				body: JSON.stringify({
					text: 'nope',
					attachment_ids: ['00000000-0000-0000-0000-000000000000'],
				}),
			});
			expect(res.status).toBe(400);
			const rows = await ctx.db.query<{ n: number }>(
				'SELECT COUNT(*)::int AS n FROM chat_messages',
			);
			expect(rows.rows[0].n).toBe(0);
		});
	});
});
