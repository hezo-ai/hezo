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
	let promptWrites: string[];
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

		promptWrites = [];
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
		// Capture every prompt written through the files seam, so a spec can
		// assert on the composed turn prompt without reaching into the manager.
		const realFiles = docker.files.bind(docker);
		docker.files = (containerId: string, containerRoot: string) => {
			const h = realFiles(containerId, containerRoot);
			return {
				...h,
				write: async (path: string, content: string) => {
					promptWrites.push(content);
					return h.write(path, content);
				},
			};
		};
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

	async function addAgent(slug: string, title: string): Promise<string> {
		const m = await ctx.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name) VALUES ($1, 'agent', $2) RETURNING id`,
			[teamId, title],
		);
		await ctx.db.query(`INSERT INTO member_agents (id, title, slug) VALUES ($1, $2, $3)`, [
			m.rows[0].id,
			title,
			slug,
		]);
		return m.rows[0].id;
	}

	async function listGroups(): Promise<Array<Record<string, unknown>>> {
		const res = await app.request(`/api/projects/${projectId}/chat/conversations`, {
			headers: headers(),
		});
		expect(res.status).toBe(200);
		return (await res.json()).data.groups;
	}

	async function createGroup(title: string, slugs: string[]): Promise<string> {
		const res = await app.request(`/api/projects/${projectId}/chat/groups`, {
			method: 'POST',
			headers: headers(),
			body: JSON.stringify({ title, participant_slugs: slugs }),
		});
		expect(res.status).toBe(201);
		return (await res.json()).data.conversation_id;
	}

	async function sendGroup(
		conversationId: string,
		text: string,
	): Promise<{ pending: string[]; userMessageId: string }> {
		const res = await app.request(
			`/api/projects/${projectId}/chat/groups/${conversationId}/messages`,
			{ method: 'POST', headers: headers(), body: JSON.stringify({ text }) },
		);
		expect(res.status).toBe(201);
		const data = (await res.json()).data;
		return { pending: data.pending_member_ids, userMessageId: data.user_message_id };
	}

	async function settledReplies(conversationId: string, count: number): Promise<void> {
		await poll(async () => {
			const r = await ctx.db.query<{ n: number }>(
				`SELECT COUNT(*)::int AS n FROM chat_messages
				 WHERE conversation_id = $1 AND role = 'assistant' AND status = 'complete'`,
				[conversationId],
			);
			return r.rows[0].n >= count;
		});
	}

	test('the list ensures the General room and keeps it synced to the roster', async () => {
		const first = await listGroups();
		expect(first).toHaveLength(1);
		expect(first[0]).toMatchObject({ is_general: true, title: 'General' });
		const participants = first[0].participants as Array<{ slug: string }>;
		expect(participants.map((p) => p.slug)).toEqual(['dev']);

		// A hire joins General on the next look; a disabled agent leaves it.
		await addAgent('designer', 'Designer');
		await ctx.db.query(
			`UPDATE member_agents SET admin_status = 'disabled' WHERE slug = 'dev' AND id = $1`,
			[memberId],
		);
		const second = await listGroups();
		const resynced = (second[0].participants as Array<{ slug: string }>).map((p) => p.slug);
		expect(resynced).toEqual(['designer']);
	});

	test('a mentioned participant replies in the room with its author identity', async () => {
		const roomId = await createGroup('Launch', ['dev']);
		const { pending } = await sendGroup(roomId, '@dev how is the header fix going?');
		expect(pending).toEqual([memberId]);
		await settledReplies(roomId, 1);

		const history = await app.request(`/api/projects/${projectId}/chat/groups/${roomId}`, {
			headers: headers(),
		});
		expect(history.status).toBe(200);
		const data = (await history.json()).data;
		expect(data.is_general).toBe(false);
		expect((data.participants as Array<{ slug: string }>).map((p) => p.slug)).toEqual(['dev']);
		const reply = data.messages.find((m: { role: string }) => m.role === 'assistant');
		expect(reply.content).toBe(REPLY);
		expect(reply.author_member_id).toBe(memberId);
		expect(reply.author_label).toBe('Dev');

		// The room shows unread on the list, like a DM.
		const groups = await listGroups();
		const room = groups.find((g) => g.id === roomId);
		expect(room?.unread).toBe(true);
		expect(String(room?.last_message_preview)).toContain('Happy to.');
	});

	test('a group turn runs on the room guide and the room memory, never the member DM memory', async () => {
		// A DM memory the room must never see.
		await ctx.db.query(
			`INSERT INTO chat_memories (member_id, content) VALUES ($1, 'dev-dm-memory-marker')`,
			[memberId],
		);
		const roomId = await createGroup('Prompt check', ['dev']);
		await sendGroup(roomId, '@dev what do you remember?');
		await settledReplies(roomId, 1);
		const prompt = promptWrites.join('\n---\n');
		expect(prompt).toContain('# Team Group Chat');
		expect(prompt).toContain('## This room');
		expect(prompt).toContain('You are replying as @dev.');
		// The room's shared memory block renders (empty), the member's does not leak.
		expect(prompt).toContain('## Long-term memory');
		expect(prompt).not.toContain('dev-dm-memory-marker');
	});

	test('an untagged message needs a locus - none before one exists, the last replier after', async () => {
		const roomId = await createGroup('Standup', ['dev']);
		const cold = await sendGroup(roomId, 'anyone around?');
		expect(cold.pending).toEqual([]);
		const replies = await ctx.db.query<{ n: number }>(
			`SELECT COUNT(*)::int AS n FROM chat_messages WHERE conversation_id = $1 AND role = 'assistant'`,
			[roomId],
		);
		expect(replies.rows[0].n).toBe(0);

		await sendGroup(roomId, '@dev hello');
		await settledReplies(roomId, 1);
		const warm = await sendGroup(roomId, 'thanks - and the tests?');
		expect(warm.pending).toEqual([memberId]);
		await settledReplies(roomId, 2);
	});

	test('mentions summon in mention order, capped at three', async () => {
		const a = await addAgent('alpha', 'Alpha');
		const b = await addAgent('beta', 'Beta');
		const g = await addAgent('gamma', 'Gamma');
		const roomId = await createGroup('War room', ['dev', 'alpha', 'beta', 'gamma']);
		const { pending } = await sendGroup(roomId, '@gamma then @alpha then @beta then @dev - go');
		expect(pending).toEqual([g, a, b]);
		await settledReplies(roomId, 3);
		const authors = await ctx.db.query<{ author_member_id: string }>(
			`SELECT author_member_id FROM chat_messages
			 WHERE conversation_id = $1 AND role = 'assistant' ORDER BY created_at ASC`,
			[roomId],
		);
		expect(authors.rows.map((r) => r.author_member_id)).toEqual([g, a, b]);
	});

	test('group creation validates the roster, and General refuses membership edits', async () => {
		const noTitle = await app.request(`/api/projects/${projectId}/chat/groups`, {
			method: 'POST',
			headers: headers(),
			body: JSON.stringify({ title: '  ', participant_slugs: ['dev'] }),
		});
		expect(noTitle.status).toBe(400);
		const badSlug = await app.request(`/api/projects/${projectId}/chat/groups`, {
			method: 'POST',
			headers: headers(),
			body: JSON.stringify({ title: 'Ghost room', participant_slugs: ['dev', 'nobody'] }),
		});
		expect(badSlug.status).toBe(400);

		const groups = await listGroups();
		const general = groups.find((gr) => gr.is_general) as { id: string };
		const editGeneral = await app.request(`/api/projects/${projectId}/chat/groups/${general.id}`, {
			method: 'PATCH',
			headers: headers(),
			body: JSON.stringify({ participant_slugs: ['dev'] }),
		});
		expect(editGeneral.status).toBe(400);
		const rename = await app.request(`/api/projects/${projectId}/chat/groups/${general.id}`, {
			method: 'PATCH',
			headers: headers(),
			body: JSON.stringify({ title: 'Team room' }),
		});
		expect(rename.status).toBe(200);
		const renamed = await listGroups();
		expect(renamed.find((gr) => gr.is_general)?.title).toBe('Team room');
	});

	test('cancelling with nothing pending reports false', async () => {
		const roomId = await createGroup('Quiet', ['dev']);
		const res = await app.request(`/api/projects/${projectId}/chat/groups/${roomId}/cancel-turn`, {
			method: 'POST',
			headers: headers(),
			body: JSON.stringify({ member_id: memberId }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.cancelled).toBe(false);
	});

	test('message-level convert files the task where the chat lives and drops the receipt', async () => {
		// DM convert: the assignee defaults to the DM partner; the stream survives.
		const { conversationId } = await sendAndSettle();
		const history = await app.request(`/api/projects/${projectId}/chat/agents/dev/conversation`, {
			headers: headers(),
		});
		const userMessage = (await history.json()).data.messages.find(
			(m: { role: string }) => m.role === 'user',
		);
		const convert = await app.request(
			`/api/projects/${projectId}/chat/conversations/${conversationId}/convert`,
			{
				method: 'POST',
				headers: headers(),
				body: JSON.stringify({ message_id: userMessage.id }),
			},
		);
		expect(convert.status).toBe(201);
		const task = (await convert.json()).data;
		expect(task.assignee_id).toBe(memberId);
		expect(task.title).toBe('can you fix the header?');
		expect(task.description).toContain('Operator: can you fix the header?');
		const stamped = await ctx.db.query<{ origin: string | null }>(
			`SELECT origin_chat_conversation_id AS origin FROM tasks WHERE id = $1`,
			[task.id],
		);
		expect(stamped.rows[0].origin).toBe(conversationId);
		const receipt = await ctx.db.query<{ content: string }>(
			`SELECT content FROM chat_messages
			 WHERE conversation_id = $1 AND system_kind = 'task_created'`,
			[conversationId],
		);
		expect(receipt.rows[0].content).toContain(`Created task ${task.identifier}`);

		// Group convert: no DM partner, so the Captain catches it.
		const captainId = await addAgent('captain', 'Captain');
		const roomId = await createGroup('Launch', ['dev']);
		const sent = await sendGroup(roomId, '@dev the footer is broken');
		await settledReplies(roomId, 1);
		const groupConvert = await app.request(
			`/api/projects/${projectId}/chat/conversations/${roomId}/convert`,
			{
				method: 'POST',
				headers: headers(),
				body: JSON.stringify({ message_id: sent.userMessageId, title: 'Fix the footer' }),
			},
		);
		expect(groupConvert.status).toBe(201);
		const groupTask = (await groupConvert.json()).data;
		expect(groupTask.assignee_id).toBe(captainId);
		expect(groupTask.title).toBe('Fix the footer');
	});

	test('the CEO stream converts a message into a picked project', async () => {
		const hq = await ctx.db.query<{ id: string }>(
			`INSERT INTO chat_conversations (member_id, team_id, project_id, channel)
			 SELECT m.id, $1, p.id, 'web' FROM members m, projects p
			  WHERE m.team_id = $1 AND p.team_id = $1 AND p.is_internal LIMIT 1
			 RETURNING id`,
			[DEFAULT_TEAM_ID],
		);
		const hqConvo = hq.rows[0].id;
		const message = await ctx.db.query<{ id: string }>(
			`INSERT INTO chat_messages (conversation_id, role, channel, status, content)
			 VALUES ($1, 'user', 'web', 'complete', 'ship the pricing page this week') RETURNING id`,
			[hqConvo],
		);
		const res = await app.request(`/api/chat/conversations/${hqConvo}/convert-message`, {
			method: 'POST',
			headers: headers(),
			body: JSON.stringify({
				message_id: message.rows[0].id,
				project: `chatproj-${n}`,
				assignee_slug: 'dev',
			}),
		});
		expect(res.status).toBe(201);
		const task = (await res.json()).data;
		expect(task.project_id).toBe(projectId);
		expect(task.assignee_id).toBe(memberId);
		const receipt = await ctx.db.query<{ content: string }>(
			`SELECT content FROM chat_messages
			 WHERE conversation_id = $1 AND system_kind = 'task_created'`,
			[hqConvo],
		);
		expect(receipt.rows[0].content).toContain(`in chatproj-${n}`);
	});
});
