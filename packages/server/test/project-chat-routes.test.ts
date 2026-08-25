import { ChatMessageStatus, DEFAULT_TEAM_ID } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { encrypt } from '../src/crypto/encryption';
import type { Env } from '../src/lib/types';
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
	claudeLine({ type: 'result', usage: { input_tokens: 10, output_tokens: 5 } });

async function poll(fn: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await fn()) return;
		await new Promise((r) => setTimeout(r, 15));
	}
	throw new Error('poll timed out');
}

/**
 * The per-project DM routes, end to end over a real manager and a scripted
 * engine whose one reply ends with a suggested-replies trailer - so the same
 * flow proves the roster listing, the unread watermark, the clean stored body,
 * and the scope boundary against the legacy global surface.
 */
describe('project chat routes', () => {
	let ctx: ServerTestContext;
	let app: Hono<Env>;
	let manager: ChatSessionManager;
	let teamId: string;
	let projectId: string;
	let memberId: string;
	let n = 0;

	const REPLY = 'Happy to. Want me to file it?';
	const TRAILER = '[[suggest: Yes, file it | Not yet]]';

	beforeAll(async () => {
		ctx = await createTestContext();
	});
	afterAll(async () => {
		await destroyTestContext(ctx);
	});

	beforeEach(async () => {
		n += 1;
		await ctx.db.query('DELETE FROM chat_messages');
		await ctx.db.query('DELETE FROM chat_sessions');
		await ctx.db.query('DELETE FROM chat_conversations');
		await ctx.db.query('DELETE FROM ai_provider_configs');
		const key = ctx.masterKeyManager.getKey();
		if (!key) throw new Error('master key unavailable');
		await ctx.db.query(
			`INSERT INTO ai_provider_configs (provider, auth_method, label, encrypted_credential, is_default, status, default_model)
			 VALUES ('anthropic', 'api_key', 'test', $1, true, 'verified', 'claude-sonnet-4-6')`,
			[encrypt('sk-ant-test', key)],
		);

		const team = await ctx.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ($1, $1) RETURNING id`,
			[`chat-co-${n}`],
		);
		teamId = team.rows[0].id;
		const project = await ctx.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, $2, $2, $3) RETURNING id`,
			[teamId, `chatproj-${n}`, `CP${n}`],
		);
		projectId = project.rows[0].id;
		const member = await ctx.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'Dev') RETURNING id`,
			[teamId],
		);
		memberId = member.rows[0].id;
		await ctx.db.query(
			`INSERT INTO member_agents (id, title, slug) VALUES ($1, 'Developer', 'dev')`,
			[memberId],
		);
		await seedProjectContainer(ctx.db, projectId, `cp-container-${n}`);

		const docker = createStubDocker(
			{
				execCreate: async () => `exec-${Math.random().toString(36).slice(2)}`,
				execStart: async (
					_id: string,
					opts: { onChunk?: (c: ExecLogChunk) => void | Promise<void> } = {},
				) => {
					const onChunk = opts.onChunk ?? (() => undefined);
					await onChunk({ stream: 'stdout', text: assistantText(`${REPLY}\n\n${TRAILER}`) });
					await onChunk({ stream: 'stdout', text: resultEvent() });
					return { stdout: '', stderr: '' };
				},
			},
			{ db: ctx.db, dataDir: ctx.dataDir },
		);
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

	const headers = () => ({ ...authHeader(ctx.token), 'Content-Type': 'application/json' });

	async function sendAndSettle(): Promise<{ conversationId: string; assistantId: string }> {
		const res = await app.request(`/api/projects/${projectId}/chat/agents/dev/messages`, {
			method: 'POST',
			headers: headers(),
			body: JSON.stringify({ text: 'can you fix the header?' }),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()).data;
		await poll(async () => {
			const r = await ctx.db.query<{ status: string }>(
				`SELECT status::text AS status FROM chat_messages WHERE id = $1`,
				[body.assistant_message_id],
			);
			return r.rows[0]?.status === ChatMessageStatus.Complete;
		});
		return { conversationId: body.conversation_id, assistantId: body.assistant_message_id };
	}

	test('roster listing carries the unread bit, and the watermark clears it', async () => {
		const empty = await app.request(`/api/projects/${projectId}/chat/conversations`, {
			headers: headers(),
		});
		expect(empty.status).toBe(200);
		const before = (await empty.json()).data.conversations;
		expect(before).toHaveLength(1);
		expect(before[0]).toMatchObject({ slug: 'dev', conversation_id: null, unread: false });

		const { conversationId } = await sendAndSettle();

		const after = await app.request(`/api/projects/${projectId}/chat/conversations`, {
			headers: headers(),
		});
		const row = (await after.json()).data.conversations[0];
		expect(row.conversation_id).toBe(conversationId);
		expect(row.unread).toBe(true);
		// The preview is the CLEAN body - the trailer never reaches a client.
		expect(row.last_message_preview).toContain('Happy to.');
		expect(row.last_message_preview).not.toContain('[[suggest');

		const mark = await app.request(`/api/chat/conversations/${conversationId}/read`, {
			method: 'POST',
			headers: headers(),
			body: JSON.stringify({ last_read_message_id: row.last_message_id }),
		});
		expect(mark.status).toBe(200);
		const cleared = await app.request(`/api/projects/${projectId}/chat/conversations`, {
			headers: headers(),
		});
		expect((await cleared.json()).data.conversations[0].unread).toBe(false);
	});

	test('a completed reply stores the clean body, the chips, and its author', async () => {
		const { conversationId, assistantId } = await sendAndSettle();
		const history = await app.request(`/api/projects/${projectId}/chat/agents/dev/conversation`, {
			headers: headers(),
		});
		expect(history.status).toBe(200);
		const data = (await history.json()).data;
		expect(data.conversation_id).toBe(conversationId);
		const assistant = data.messages.find((m: { id: string }) => m.id === assistantId);
		expect(assistant.content).toBe(REPLY);
		expect(assistant.suggested_replies).toEqual(['Yes, file it', 'Not yet']);
		expect(assistant.author_member_id).toBe(memberId);
	});

	test('the legacy global surface refuses a project DM', async () => {
		const { conversationId, assistantId } = await sendAndSettle();
		const read = await app.request(`/api/chat/conversation?conversation_id=${conversationId}`, {
			headers: headers(),
		});
		expect(read.status).toBe(404);
		const send = await app.request('/api/chat/messages', {
			method: 'POST',
			headers: headers(),
			body: JSON.stringify({ conversation_id: conversationId, text: 'hi' }),
		});
		expect(send.status).toBe(404);
		// The watermark route is the deliberate exception: it is global and
		// authorizes against the conversation's own team - but it still refuses a
		// message that is not in that conversation.
		const hq = await ctx.db.query<{ id: string }>(
			`INSERT INTO chat_conversations (member_id, team_id, project_id, channel)
			 SELECT m.id, $1, p.id, 'web' FROM members m, projects p
			  WHERE m.team_id = $1 AND p.team_id = $1 AND p.is_internal LIMIT 1
			 RETURNING id`,
			[DEFAULT_TEAM_ID],
		);
		const cross = await app.request(`/api/chat/conversations/${hq.rows[0].id}/read`, {
			method: 'POST',
			headers: headers(),
			body: JSON.stringify({ last_read_message_id: assistantId }),
		});
		expect(cross.status).toBe(400);
	});

	test('an unknown or disabled agent slug answers 404', async () => {
		const res = await app.request(`/api/projects/${projectId}/chat/agents/nobody/messages`, {
			method: 'POST',
			headers: headers(),
			body: JSON.stringify({ text: 'hello?' }),
		});
		expect(res.status).toBe(404);
	});
});
