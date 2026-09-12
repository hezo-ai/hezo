import { AuthType, ChatMessageStatus, ChatSystemMessageKind } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PgliteDb } from '../src/db/drivers/pglite';
import type { AuthInfo } from '../src/lib/types';
import { postTaskStatusBreadcrumb, recordChatTaskOrigin } from '../src/services/chat-breadcrumbs';
import { createTestDbWithMigrations } from './helpers/db';

/**
 * The task<->chat receipts, driven at the service seam the MCP handler and the
 * status automations call. The end-to-end halves (a real create_task exec, a
 * real status change) are covered by the tool and automation suites; what this
 * pins is the attribution rule - the streaming reply under the caller's
 * session names the conversation - and that each transition leaves exactly the
 * row it should.
 */
describe('chat task breadcrumbs', () => {
	let db: PgliteDb;
	let teamId: string;
	let projectId: string;
	let memberId: string;
	let sessionId: string;
	let conversationId: string;
	let taskId: string;

	const agentAuth = (): AuthInfo =>
		({ type: AuthType.Agent, memberId, teamId, sessionId }) as AuthInfo;

	const systemRows = async () =>
		(
			await db.query<{ system_kind: string; content: string }>(
				`SELECT system_kind, content FROM chat_messages
				 WHERE conversation_id = $1 AND role = 'system' ORDER BY created_at ASC`,
				[conversationId],
			)
		).rows;

	beforeAll(async () => {
		db = await createTestDbWithMigrations();
		const team = await db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Crumb Co', 'crumb-co') RETURNING id`,
		);
		teamId = team.rows[0].id;
		const project = await db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'Crumbs', 'crumbs', 'CR') RETURNING id`,
			[teamId],
		);
		projectId = project.rows[0].id;
		const member = await db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'Dev') RETURNING id`,
			[teamId],
		);
		memberId = member.rows[0].id;
		await db.query(`INSERT INTO member_agents (id, title, slug) VALUES ($1, 'Developer', 'dev')`, [
			memberId,
		]);
		const session = await db.query<{ id: string }>(
			`INSERT INTO chat_sessions (member_id, team_id, project_id, runtime_type, status)
			 VALUES ($1, $2, $3, 'claude_code', 'running') RETURNING id`,
			[memberId, teamId, projectId],
		);
		sessionId = session.rows[0].id;
		const convo = await db.query<{ id: string }>(
			`INSERT INTO chat_conversations (member_id, team_id, project_id, channel)
			 VALUES ($1, $2, $3, 'web') RETURNING id`,
			[memberId, teamId, projectId],
		);
		conversationId = convo.rows[0].id;
		// The in-flight reply that makes this conversation the acting one.
		await db.query(
			`INSERT INTO chat_messages (conversation_id, role, channel, status, content, session_id)
			 VALUES ($1, 'assistant', 'web', $2::chat_message_status, '', $3)`,
			[conversationId, ChatMessageStatus.Streaming, sessionId],
		);
		const task = await db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title)
			 VALUES ($1, $2, 1, 'CR-1', 'Fix the header') RETURNING id`,
			[teamId, projectId],
		);
		taskId = task.rows[0].id;
	});
	afterAll(() => db.close());

	it('stamps the task with the acting conversation and leaves the created receipt', async () => {
		await recordChatTaskOrigin(db, undefined, agentAuth(), {
			id: taskId,
			identifier: 'CR-1',
			title: 'Fix the header',
			project_id: projectId,
		});
		const origin = await db.query<{ origin: string | null }>(
			`SELECT origin_chat_conversation_id AS origin FROM tasks WHERE id = $1`,
			[taskId],
		);
		expect(origin.rows[0].origin).toBe(conversationId);
		const rows = await systemRows();
		expect(rows).toHaveLength(1);
		expect(rows[0].system_kind).toBe(ChatSystemMessageKind.TaskCreated);
		expect(rows[0].content).toBe('Created task CR-1 in Crumbs: Fix the header');
	});

	it('does nothing for a caller with no chat session', async () => {
		await recordChatTaskOrigin(
			db,
			undefined,
			{ type: AuthType.Agent, memberId, teamId } as AuthInfo,
			{ id: taskId, identifier: 'CR-1' },
		);
		expect(await systemRows()).toHaveLength(1);
	});

	it('reports completion and a block back to the origin, and nothing else', async () => {
		await postTaskStatusBreadcrumb(db, undefined, taskId, 'in_progress');
		expect(await systemRows()).toHaveLength(1);
		await postTaskStatusBreadcrumb(db, undefined, taskId, 'done');
		await postTaskStatusBreadcrumb(db, undefined, taskId, 'blocked');
		const rows = await systemRows();
		expect(rows.map((r) => r.system_kind)).toEqual([
			ChatSystemMessageKind.TaskCreated,
			ChatSystemMessageKind.TaskCompleted,
			ChatSystemMessageKind.TaskBlocked,
		]);
		expect(rows[1].content).toBe('Task CR-1 completed: Fix the header');
		expect(rows[2].content).toBe('Task CR-1 is blocked and needs you: Fix the header');
	});

	it('a task with no origin stays silent on every transition', async () => {
		const other = await db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title)
			 VALUES ($1, $2, 2, 'CR-2', 'No chat here') RETURNING id`,
			[teamId, projectId],
		);
		await postTaskStatusBreadcrumb(db, undefined, other.rows[0].id, 'done');
		expect(await systemRows()).toHaveLength(3);
	});
});
