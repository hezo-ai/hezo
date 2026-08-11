import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	CAPTAIN_AGENT_SLUG,
	ChatMessageStatus,
	ChatSystemMessageKind,
	DEFAULT_TEAM_ID,
	TaskStatus,
} from '@hezo/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { encrypt } from '../src/crypto/encryption';
import { ChatSessionManager } from '../src/services/chat-session-manager';
import type { ExecLogChunk } from '../src/services/docker';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import { getWorkspacePath } from '../src/services/workspace';
import { WebSocketManager } from '../src/services/ws';
import {
	createStubDocker,
	createTestProject,
	createTestTeam,
	instanceCeoId,
	seedProjectContainer,
} from './helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

/**
 * The chat's no-wake exit check. A CEO chat turn can comment on any project's
 * task, and a comment that names a teammate without an active @-mention notifies
 * nobody - the same stranded handoff the runner catches on the task-run path,
 * which a chat turn never takes. The completeness Stop-hook judge cannot cover
 * this (it reads only the final message, and in chat that message IS delivered,
 * to the operator), so the structural check is what stands in for it.
 *
 * The comment is inserted from inside the exec, exactly where a `create_comment`
 * MCP call from the running CLI would land it: authored by the CEO with no
 * `created_by_run_id`, since a chat session authenticates against `chat_sessions`
 * and has no run id.
 */

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

describe('CEO chat no-wake exit check', () => {
	let ctx: ServerTestContext;
	let hqProjectId: string;
	let ceoId: string;
	let taskId: string;
	let taskIdentifier: string;

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
		await ctx.db.query('DELETE FROM task_comments');

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
		hqProjectId = proj.rows[0].id;
		await ctx.db.query('DELETE FROM container_pool_members WHERE project_id = $1', [hqProjectId]);
		await seedProjectContainer(ctx.db, hqProjectId, 'hq-container');
		ceoId = await instanceCeoId(ctx.db);

		// A separate project team, so the comment the CEO posts is cross-team - the
		// case the roster lookup has to resolve against the TASK's team, not HQ.
		const team = await createTestTeam(ctx.db, { name: `Delivery ${Date.now()}` });
		const teamId = (await team.json()).data.id;
		const project = await createTestProject(ctx.db, teamId, { name: 'Launch' });
		const projectId = (await project.json()).data.id;
		const meta = await ctx.db.query<{ task_prefix: string; number: number }>(
			`SELECT p.task_prefix, next_project_task_number(p.id) AS number
			 FROM projects p WHERE p.id = $1`,
			[projectId],
		);
		const n = meta.rows[0].number;
		taskIdentifier = `${meta.rows[0].task_prefix}-${n}`;
		const task = await ctx.db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title, status, priority, labels)
			 VALUES ($1, $2, $3, $4, 'Ship the thing', $5::task_status, 'medium'::task_priority, '[]'::jsonb)
			 RETURNING id`,
			[teamId, projectId, n, taskIdentifier, TaskStatus.InProgress],
		);
		taskId = task.rows[0].id;
	});

	/**
	 * Docker stub whose reply exec first posts `commentText` as the CEO on the
	 * seeded task, then streams a reply and exits. Background title/compaction
	 * execs stream nothing.
	 */
	function makeCommentingDocker(commentText: string) {
		const toHostPath = (containerPath: string) =>
			join(
				getWorkspacePath(ctx.dataDir, DEFAULT_TEAM_ID, hqProjectId),
				containerPath.replace(/^\/workspace\//, ''),
			);
		let isReply = false;
		return createStubDocker({
			execCreate: async (_id: string, config: { Env?: string[] }) => {
				const promptEntry = (config.Env ?? []).find((e) => e.startsWith('HEZO_PROMPT_FILE='));
				const prompt = promptEntry
					? readFileSync(toHostPath(promptEntry.slice('HEZO_PROMPT_FILE='.length)), 'utf8')
					: '';
				isReply = prompt.includes('Reply to the latest operator message as the CEO.');
				return isReply ? 'exec-reply' : 'exec-side';
			},
			execStart: async (
				execId: string,
				opts: { onChunk?: (c: ExecLogChunk) => void | Promise<void> },
			) => {
				if (execId !== 'exec-reply') return { stdout: '', stderr: '' };
				// Where a create_comment MCP call from the running CLI lands: the CEO
				// as author, no run id (a chat session has none).
				await ctx.db.query(
					`INSERT INTO task_comments (task_id, author_member_id, content_type, content, created_by_run_id)
					 VALUES ($1, $2, 'text', $3::jsonb, NULL)`,
					[taskId, ceoId, JSON.stringify({ text: commentText })],
				);
				await opts.onChunk?.({ stream: 'stdout', text: assistantText('Posted an update.') });
				return { stdout: '', stderr: '' };
			},
		});
	}

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

	async function runTurn(commentText: string): Promise<string> {
		const manager = makeManager(makeCommentingDocker(commentText));
		const { assistantMessageId, conversationId } = await manager.sendTurn({ text: 'status?' });
		await poll(async () => {
			const r = await ctx.db.query<{ status: string }>(
				'SELECT status FROM chat_messages WHERE id = $1',
				[assistantMessageId],
			);
			return r.rows[0]?.status === ChatMessageStatus.Complete;
		});
		await manager.stop();
		return conversationId;
	}

	async function systemWarnings(conversationId: string) {
		const r = await ctx.db.query<{ content: string; system_kind: string | null }>(
			`SELECT content, system_kind FROM chat_messages
			 WHERE conversation_id = $1 AND role = 'system' ORDER BY created_at ASC`,
			[conversationId],
		);
		return r.rows;
	}

	test('warns when a turn names a teammate passively and wakes nobody', async () => {
		const conversationId = await runTurn(`@@${CAPTAIN_AGENT_SLUG} should pick this up next.`);

		const rows = await systemWarnings(conversationId);
		expect(rows.length).toBe(1);
		expect(rows[0].system_kind).toBe(ChatSystemMessageKind.HandoffNotDelivered);
		expect(rows[0].content).toContain(taskIdentifier);
		expect(rows[0].content).toContain(CAPTAIN_AGENT_SLUG);
		// The remedy names the active spelling, since posting it is the fix.
		expect(rows[0].content).toContain(`@${CAPTAIN_AGENT_SLUG}`);
	});

	test('stays quiet when the comment carries an active mention', async () => {
		const conversationId = await runTurn(`@${CAPTAIN_AGENT_SLUG} please pick this up next.`);
		expect(await systemWarnings(conversationId)).toEqual([]);
	});

	test('stays quiet when the comment names no teammate at all', async () => {
		const conversationId = await runTurn('Recorded the decision on this task.');
		expect(await systemWarnings(conversationId)).toEqual([]);
	});

	test('stays quiet when the task is already closed', async () => {
		await ctx.db.query(`UPDATE tasks SET status = $2::task_status WHERE id = $1`, [
			taskId,
			TaskStatus.Done,
		]);
		const conversationId = await runTurn(`@@${CAPTAIN_AGENT_SLUG} should pick this up next.`);
		expect(await systemWarnings(conversationId)).toEqual([]);
	});

	test('ignores comments that predate the turn', async () => {
		await ctx.db.query(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content, created_by_run_id)
			 VALUES ($1, $2, 'text', $3::jsonb, NULL)`,
			[taskId, ceoId, JSON.stringify({ text: `@@${CAPTAIN_AGENT_SLUG} take a look` })],
		);
		// This turn posts a clean comment; the older stranded one is not its doing.
		const conversationId = await runTurn('Recorded the decision on this task.');
		expect(await systemWarnings(conversationId)).toEqual([]);
	});
});
