import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	AuthType,
	CEO_AGENT_SLUG,
	ChatMessageRole,
	ChatMessageStatus,
	DEFAULT_TEAM_ID,
	TaskPriority,
	TaskStatus,
	WakeupSource,
	wsRoom,
} from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { encrypt } from '../src/crypto/encryption';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { ChatSessionManager } from '../src/services/chat-session-manager';
import type { ExecLogChunk } from '../src/services/docker';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import { getWorkspacePath } from '../src/services/workspace';
import type { WsSocket } from '../src/services/ws';
import { WebSocketManager } from '../src/services/ws';
import { buildApp } from '../src/startup';
import { authHeader, createStubDocker } from './helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

const claudeLine = (obj: unknown) => `${JSON.stringify(obj)}\n`;
const assistantText = (text: string) =>
	claudeLine({
		type: 'assistant',
		message: { role: 'assistant', content: [{ type: 'text', text }] },
	});

async function poll(fn: () => Promise<boolean>, timeoutMs = 4000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await fn()) return;
		await new Promise((r) => setTimeout(r, 15));
	}
	throw new Error('poll timed out');
}

/** Unwrapped success payload of POST /convert-to-task (the `ok()` data envelope). */
interface ConvertResponse {
	task: { id: string; identifier: string; title: string; project_slug: string };
	conversation: {
		id: string;
		closed_at: string | null;
		converted_task_id: string | null;
		converted_task: { identifier: string; project_slug: string } | null;
	};
}

/**
 * Docker stub whose reply exec streams a partial then blocks until aborted —
 * the shape of a turn interrupted mid-stream (crib of chat-session.test.ts's
 * block mode, minus the prompt capture this suite doesn't need).
 */
function blockingDocker(dataDir: string, hqProjectId: string) {
	const scenario = { entered: false };
	const toHostPath = (containerPath: string) =>
		join(
			getWorkspacePath(dataDir, DEFAULT_TEAM_ID, hqProjectId),
			containerPath.replace(/^\/workspace\//, ''),
		);
	const docker = createStubDocker({
		execCreate: async (_id: string, config: { Env?: string[] }) => {
			const promptEntry = (config.Env ?? []).find((e) => e.startsWith('HEZO_PROMPT_FILE='));
			if (!promptEntry) return 'exec-other';
			const prompt = readFileSync(
				toHostPath(promptEntry.slice('HEZO_PROMPT_FILE='.length)),
				'utf8',
			);
			// The parallel auto-title exec must return, or manager.stop() would wait
			// on it; only the operator-reply turn blocks.
			return prompt.includes('Reply to the latest operator message as the CEO.')
				? 'exec-reply'
				: 'exec-other';
		},
		execStart: async (
			execId: string,
			opts: { signal?: AbortSignal; onChunk?: (c: ExecLogChunk) => void | Promise<void> },
		) => {
			const onChunk = opts.onChunk ?? (() => undefined);
			if (execId !== 'exec-reply') {
				await onChunk({ stream: 'stdout', text: assistantText('Untitled') });
				return { stdout: '', stderr: '' };
			}
			scenario.entered = true;
			await onChunk({ stream: 'stdout', text: assistantText('let me think about that') });
			await new Promise<void>((_resolve, reject) => {
				opts.signal?.addEventListener('abort', () =>
					reject(new DOMException('Aborted', 'AbortError')),
				);
			});
			return { stdout: '', stderr: '' };
		},
	});
	return { docker, scenario };
}

function captureChatRoom(wsManager: WebSocketManager): Array<Record<string, unknown>> {
	const events: Array<Record<string, unknown>> = [];
	const socket: WsSocket = {
		data: { auth: { type: AuthType.Admin, isSuperuser: true }, rooms: new Set() },
		send: (msg: string) => events.push(JSON.parse(msg)),
	};
	wsManager.subscribe(socket, wsRoom.chat());
	return events;
}

describe('convert a chat conversation to a task', () => {
	let ctx: ServerTestContext;
	let manager: ChatSessionManager;
	let wsManager: WebSocketManager;
	let app: Hono<Env>;
	let wsEvents: Array<Record<string, unknown>>;
	let hqProjectId: string;
	let ceoMemberId: string;
	let targetTeamId: string;
	let targetProjectId: string;
	let headers: Record<string, string>;

	beforeAll(async () => {
		ctx = await createTestContext();
		headers = { ...authHeader(ctx.token), 'Content-Type': 'application/json' };
		const ceo = await ctx.db.query<{ id: string }>(
			`SELECT m.id FROM members m JOIN member_agents ma ON ma.id = m.id
			 WHERE ma.slug = $1 AND m.team_id = $2`,
			[CEO_AGENT_SLUG, DEFAULT_TEAM_ID],
		);
		ceoMemberId = ceo.rows[0].id;
	});
	afterAll(async () => {
		await destroyTestContext(ctx);
	});

	beforeEach(async () => {
		await ctx.db.query('DELETE FROM chat_messages');
		await ctx.db.query('DELETE FROM chat_sessions');
		await ctx.db.query('DELETE FROM chat_conversations');
		await ctx.db.query('DELETE FROM agent_wakeup_requests');
		await ctx.db.query('DELETE FROM ai_provider_configs');
		await ctx.db.query(`DELETE FROM tasks WHERE team_id <> $1`, [DEFAULT_TEAM_ID]);
		await ctx.db.query(`DELETE FROM projects WHERE team_id <> $1`, [DEFAULT_TEAM_ID]);
		await ctx.db.query(`DELETE FROM teams WHERE id <> $1`, [DEFAULT_TEAM_ID]);

		const hq = await ctx.db.query<{ id: string }>(
			`SELECT id FROM projects WHERE team_id = $1 AND is_internal = true`,
			[DEFAULT_TEAM_ID],
		);
		hqProjectId = hq.rows[0].id;
		const team = await ctx.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Web Team', 'web-team') RETURNING id`,
		);
		targetTeamId = team.rows[0].id;
		const project = await ctx.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'Website', 'website', 'WEB') RETURNING id`,
			[targetTeamId],
		);
		targetProjectId = project.rows[0].id;

		const docker = createStubDocker();
		wsManager = new WebSocketManager();
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
		wsEvents = captureChatRoom(wsManager);
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
	}): Promise<string> {
		const r = await ctx.db.query<{ id: string }>(
			`INSERT INTO chat_messages (conversation_id, role, channel, status, content, compacted_at, completed_at)
			 VALUES ($1, $2::chat_message_role, 'web'::chat_channel, $3::chat_message_status, $4,
			         ${input.compacted ? 'now()' : 'NULL'}, now())
			 RETURNING id`,
			[
				input.conversationId,
				input.role ?? ChatMessageRole.User,
				input.status ?? ChatMessageStatus.Complete,
				input.content,
			],
		);
		return r.rows[0].id;
	}

	/** A titled web conversation with one operator/CEO exchange. */
	async function seedConversation(title: string | null = 'Landing page revamp'): Promise<string> {
		const id = await manager.createWebConversation(title ?? undefined);
		await seedMessage({ conversationId: id, content: 'The hero feels stale, rework it' });
		await seedMessage({
			conversationId: id,
			role: ChatMessageRole.Assistant,
			content: 'Agreed, I would rework the hero and retake the screenshots.',
		});
		return id;
	}

	function convert(
		id: string,
		body: Record<string, unknown> = { project_id: 'website' },
		h: Record<string, string> = headers,
	) {
		return app.request(`/api/chat/conversations/${id}/convert-to-task`, {
			method: 'POST',
			headers: h,
			body: JSON.stringify(body),
		});
	}

	test('creates the task, writes the meta message, closes and keeps the thread listed', async () => {
		const convoId = await seedConversation();
		const res = await convert(convoId, { project_id: 'website' });
		expect(res.status).toBe(201);
		const body = ((await res.json()) as { data: ConvertResponse }).data;
		// Task landed in the target project, assigned to the CEO, defaults intact.
		expect(body.task.identifier).toMatch(/^WEB-\d+$/);
		expect(body.task.project_slug).toBe('website');
		expect(body.task.title).toBe('Landing page revamp');
		const task = await ctx.db.query<{
			project_id: string;
			team_id: string;
			assignee_id: string;
			description: string;
			status: string;
			priority: string;
		}>(
			`SELECT project_id, team_id, assignee_id, description, status, priority FROM tasks WHERE id = $1`,
			[body.task.id],
		);
		expect(task.rows[0].project_id).toBe(targetProjectId);
		expect(task.rows[0].team_id).toBe(targetTeamId);
		expect(task.rows[0].assignee_id).toBe(ceoMemberId);
		expect(task.rows[0].status).toBe(TaskStatus.Backlog);
		expect(task.rows[0].priority).toBe(TaskPriority.Medium);
		// The description carries the labelled transcript, verbatim.
		expect(task.rows[0].description).toContain('created from a CEO chat conversation');
		expect(task.rows[0].description).toContain('Operator: The hero feels stale, rework it');
		expect(task.rows[0].description).toContain(
			'CEO: Agreed, I would rework the hero and retake the screenshots.',
		);

		// The assignment wakeup targets the CEO in the TARGET project's team (the
		// run-team split — the run must scope to the task's project).
		const wakeup = await ctx.db.query<{ team_id: string; source: string }>(
			`SELECT team_id, source::text AS source FROM agent_wakeup_requests WHERE member_id = $1`,
			[ceoMemberId],
		);
		expect(wakeup.rows.length).toBe(1);
		expect(wakeup.rows[0].team_id).toBe(targetTeamId);
		expect(wakeup.rows[0].source).toBe(WakeupSource.Assignment);

		// A persisted system meta message ends the thread and names the task.
		const meta = await ctx.db.query<{ content: string; status: string }>(
			`SELECT content, status::text AS status FROM chat_messages
			 WHERE conversation_id = $1 AND role = 'system'`,
			[convoId],
		);
		expect(meta.rows.length).toBe(1);
		expect(meta.rows[0].status).toBe(ChatMessageStatus.Complete);
		expect(meta.rows[0].content).toContain(body.task.identifier);

		// Conversation closed + marked converted, with the joined task reference.
		expect(body.conversation.closed_at).not.toBeNull();
		expect(body.conversation.converted_task_id).toBe(body.task.id);
		expect(body.conversation.converted_task?.identifier).toBe(body.task.identifier);
		expect(body.conversation.converted_task?.project_slug).toBe('website');

		// Broadcasts: the system message start and the lifecycle update.
		const start = wsEvents.find((e) => e.type === 'chat_message_start' && e.role === 'system') as
			| { content: string }
			| undefined;
		expect(start).toBeDefined();
		expect(start?.content).toContain(body.task.identifier);
		const updated = wsEvents.find((e) => e.type === 'chat_conversation_updated') as
			| { convertedTaskId?: string; closedAt?: string }
			| undefined;
		expect(updated?.convertedTaskId).toBe(body.task.id);
		expect(updated?.closedAt).toBeTruthy();
	});

	test('a converted thread stays in the default listing; a plainly closed one drops out', async () => {
		const convoId = await seedConversation();
		const other = await seedConversation('Other thread');
		await convert(convoId);
		await app.request(`/api/chat/conversations/${other}/close`, { method: 'POST', headers });

		const res = await app.request('/api/chat/conversations', { headers });
		const body = (
			(await res.json()) as {
				data: {
					conversations: Array<{ id: string; converted_task: { identifier: string } | null }>;
				};
			}
		).data;
		const ids = body.conversations.map((c) => c.id);
		expect(ids).toContain(convoId);
		expect(ids).not.toContain(other);
		const converted = body.conversations.find((c) => c.id === convoId);
		expect(converted?.converted_task?.identifier).toMatch(/^WEB-\d+$/);

		// Deleting the task demotes the thread to ordinary-closed (SET NULL) and it
		// leaves the listing — the operator's cleanup path.
		const conv = await ctx.db.query<{ converted_task_id: string }>(
			`SELECT converted_task_id FROM chat_conversations WHERE id = $1`,
			[convoId],
		);
		await ctx.db.query(`DELETE FROM tasks WHERE id = $1`, [conv.rows[0].converted_task_id]);
		const after = await app.request('/api/chat/conversations', { headers });
		const afterBody = ((await after.json()) as { data: { conversations: Array<{ id: string }> } })
			.data;
		expect(afterBody.conversations.map((c) => c.id)).not.toContain(convoId);
	});

	test('sending into a converted thread is a 409 naming the task; a closed thread a plain 409', async () => {
		const convoId = await seedConversation();
		await convert(convoId);
		const send = await app.request('/api/chat/messages', {
			method: 'POST',
			headers,
			body: JSON.stringify({ text: 'one more thing', conversation_id: convoId }),
		});
		expect(send.status).toBe(409);
		const body = (await send.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe('CLOSED');
		expect(body.error.message).toMatch(/WEB-\d+/);

		const other = await seedConversation('Other');
		await app.request(`/api/chat/conversations/${other}/close`, { method: 'POST', headers });
		const send2 = await app.request('/api/chat/messages', {
			method: 'POST',
			headers,
			body: JSON.stringify({ text: 'hello?', conversation_id: other }),
		});
		expect(send2.status).toBe(409);
		expect(((await send2.json()) as { error: { code: string } }).error.code).toBe('CLOSED');
	});

	test('guards: unknown ids, coworker threads, repeat converts, empty threads, bad input', async () => {
		const convoId = await seedConversation();

		const noProject = await convert(convoId, {});
		expect(noProject.status).toBe(400);

		const badProject = await convert(convoId, { project_id: 'no-such-project' });
		expect(badProject.status).toBe(404);

		const badConvo = await convert('00000000-0000-0000-0000-000000000000');
		expect(badConvo.status).toBe(404);

		// Coworker (team-channel) threads convert nowhere from the web view.
		const coworker = await ctx.db.query<{ id: string }>(
			`INSERT INTO chat_conversations (member_id, team_id, project_id, channel, external_thread_id, kind, title)
			 VALUES ($1, $2, $3, 'slack', 'C123:1', 'coworker', '#general') RETURNING id`,
			[ceoMemberId, DEFAULT_TEAM_ID, hqProjectId],
		);
		await seedMessage({ conversationId: coworker.rows[0].id, content: 'channel chatter' });
		const cw = await convert(coworker.rows[0].id);
		expect(cw.status).toBe(409);
		expect(((await cw.json()) as { error: { code: string } }).error.code).toBe('READ_ONLY');

		// Nothing to convert: a thread with no complete messages.
		const empty = await manager.createWebConversation('Empty');
		const emptyRes = await convert(empty);
		expect(emptyRes.status).toBe(400);
		expect(((await emptyRes.json()) as { error: { code: string } }).error.code).toBe(
			'INVALID_REQUEST',
		);

		// A second convert reports the thread already carries its task.
		const first = await convert(convoId);
		expect(first.status).toBe(201);
		const second = await convert(convoId);
		expect(second.status).toBe(409);
		expect(((await second.json()) as { error: { code: string } }).error.code).toBe(
			'ALREADY_CONVERTED',
		);
		// And only one task was ever created from it.
		const tasks = await ctx.db.query<{ n: number }>(
			`SELECT COUNT(*)::int AS n FROM tasks WHERE team_id = $1`,
			[targetTeamId],
		);
		expect(tasks.rows[0].n).toBe(1);
	});

	test('authorization: unauthenticated and non-HQ users are rejected', async () => {
		const convoId = await seedConversation();
		const anon = await convert(
			convoId,
			{ project_id: 'website' },
			{
				'Content-Type': 'application/json',
			},
		);
		expect(anon.status).toBe(401);

		const user = await ctx.db.query<{ id: string }>(
			`INSERT INTO users (display_name, is_superuser) VALUES ('Outsider', false) RETURNING id`,
		);
		const token = await signAdminJwt(ctx.masterKeyManager, user.rows[0].id);
		const outsider = await convert(
			convoId,
			{ project_id: 'website' },
			{
				...authHeader(token),
				'Content-Type': 'application/json',
			},
		);
		expect(outsider.status).toBe(403);
		// Nothing happened: thread open, no task.
		const convo = await ctx.db.query<{ closed_at: string | null }>(
			`SELECT closed_at FROM chat_conversations WHERE id = $1`,
			[convoId],
		);
		expect(convo.rows[0].closed_at).toBeNull();
	});

	test('a compacted history is noted in the description, not silently missing', async () => {
		const convoId = await seedConversation();
		await seedMessage({ conversationId: convoId, content: 'old context', compacted: true });
		const res = await convert(convoId);
		const body = ((await res.json()) as { data: ConvertResponse }).data;
		const task = await ctx.db.query<{ description: string }>(
			`SELECT description FROM tasks WHERE id = $1`,
			[body.task.id],
		);
		expect(task.rows[0].description).toContain('compacted');
		expect(task.rows[0].description).not.toContain('old context');
	});

	test('converting mid-stream aborts the reply (kept as interrupted) and still converts', async () => {
		const key = ctx.masterKeyManager.getKey();
		if (!key) throw new Error('master key unavailable');
		await ctx.db.query(
			`INSERT INTO ai_provider_configs (provider, auth_method, label, encrypted_credential, is_default, status, default_model)
			 VALUES ('anthropic', 'api_key', 'test', $1, true, 'verified', 'claude-sonnet-4-6')`,
			[encrypt('sk-ant-test', key)],
		);
		await ctx.db.query(
			`UPDATE projects SET container_id = 'hq-container', container_status = 'running' WHERE id = $1`,
			[hqProjectId],
		);
		// Swap in a manager whose reply exec blocks until aborted.
		await manager.stop();
		const blocking = blockingDocker(ctx.dataDir, hqProjectId);
		const logs = new LogStreamBroker();
		manager = new ChatSessionManager({
			db: ctx.db,
			docker: blocking.docker,
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
			blocking.docker,
			wsManager,
			undefined,
			logs,
			null,
			null,
			undefined,
			undefined,
			manager,
		);

		const turn = await manager.sendTurn({ text: 'Rework the landing page hero' });
		await poll(async () => blocking.scenario.entered);

		const res = await convert(turn.conversationId);
		expect(res.status).toBe(201);
		const body = ((await res.json()) as { data: ConvertResponse }).data;

		// The in-flight reply settled as interrupted, not lost and not left running.
		const partial = await ctx.db.query<{ status: string }>(
			`SELECT status::text AS status FROM chat_messages WHERE id = $1`,
			[turn.assistantMessageId],
		);
		expect(partial.rows[0].status).toBe(ChatMessageStatus.Interrupted);
		// The operator's message made the transcript (the interrupted partial is
		// excluded, matching the window every other transcript consumer sees).
		const task = await ctx.db.query<{ description: string }>(
			`SELECT description FROM tasks WHERE id = $1`,
			[body.task.id],
		);
		expect(task.rows[0].description).toContain('Operator: Rework the landing page hero');
	});

	test('closing a thread broadcasts the lifecycle update', async () => {
		const convoId = await seedConversation();
		await app.request(`/api/chat/conversations/${convoId}/close`, { method: 'POST', headers });
		const updated = wsEvents.find(
			(e) => e.type === 'chat_conversation_updated' && e.conversationId === convoId,
		) as { closedAt?: string } | undefined;
		expect(updated?.closedAt).toBeTruthy();
	});
});
