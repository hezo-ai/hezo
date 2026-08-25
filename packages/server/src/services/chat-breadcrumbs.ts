import {
	AuthType,
	ChatMessageRole,
	ChatMessageStatus,
	ChatSystemMessageKind,
	DEFAULT_TEAM_ID,
	TaskStatus,
	WsMessageType,
	wsRoom,
} from '@hezo/shared';
import type { Db } from '../db/database';
import type { AuthInfo } from '../lib/types';
import { logger } from '../logger';
import type { WebSocketManager } from './ws';

const log = logger.child('chat-breadcrumbs');

/**
 * Task<->chat breadcrumbs: server-emitted system rows in the conversation a
 * task came from, closing the "ask -> task -> silence" loop structurally. A
 * task created by a chat turn is stamped with its originating conversation
 * (`tasks.origin_chat_conversation_id`), and that conversation then receives a
 * receipt when the task is created, completed, or blocked.
 *
 * Standalone rather than a `ChatSessionManager` method because two of the
 * three writers have no manager in reach: the MCP `create_task` handler and
 * the status automations, both of which run with only (db, wsManager). The
 * fan-out mirrors the manager's boundary-event routing: the conversation's own
 * room plus its team's signal room (`chat:global` for HQ).
 */
export async function postChatSystemMessage(
	db: Db,
	wsManager: WebSocketManager | undefined,
	conversationId: string,
	kind: ChatSystemMessageKind,
	content: string,
): Promise<string | null> {
	const convo = await db.query<{ team_id: string }>(
		`SELECT team_id FROM chat_conversations WHERE id = $1`,
		[conversationId],
	);
	const row = convo.rows[0];
	if (!row) return null;
	const inserted = await db.query<{ id: string; created_at: string }>(
		`INSERT INTO chat_messages (conversation_id, role, channel, status, content, system_kind, completed_at)
		 VALUES ($1, $2::chat_message_role, 'web', $3::chat_message_status, $4, $5, now())
		 RETURNING id, created_at`,
		[conversationId, ChatMessageRole.System, ChatMessageStatus.Complete, content, kind],
	);
	const messageId = inserted.rows[0].id;
	await db.query(
		`UPDATE chat_conversations SET last_message_id = $2, last_activity_at = now() WHERE id = $1`,
		[conversationId, messageId],
	);
	if (wsManager) {
		const message = {
			type: WsMessageType.ChatMessageStart,
			conversationId,
			messageId,
			role: ChatMessageRole.System,
			channel: 'web',
			content,
			createdAt: inserted.rows[0].created_at,
			systemKind: kind,
		};
		wsManager.broadcast(wsRoom.chatConversation(conversationId), { ...message });
		wsManager.broadcast(
			row.team_id === DEFAULT_TEAM_ID ? wsRoom.chat() : wsRoom.chatTeam(row.team_id),
			{ ...message },
		);
	}
	return messageId;
}

/**
 * Stamp a task an in-flight chat turn just created with its originating
 * conversation, and drop the "created" receipt there.
 *
 * The acting conversation is resolved structurally, not from in-memory state:
 * it is the conversation whose assistant reply is currently `streaming` under
 * the caller's chat session. A session with two concurrent turns (possible for
 * the CEO) attributes to the newest - the same imprecision the connector
 * warnings accept, costing a receipt in a sibling thread rather than none
 * anywhere. Best-effort: a failure here must not fail the task creation.
 */
export async function recordChatTaskOrigin(
	db: Db,
	wsManager: WebSocketManager | undefined,
	auth: AuthInfo,
	task: { id: string; identifier: string } & Record<string, unknown>,
): Promise<void> {
	try {
		if (auth.type !== AuthType.Agent || !auth.sessionId) return;
		const convo = await db.query<{ conversation_id: string }>(
			`SELECT conversation_id FROM chat_messages
			 WHERE session_id = $1 AND status = $2::chat_message_status
			 ORDER BY created_at DESC LIMIT 1`,
			[auth.sessionId, ChatMessageStatus.Streaming],
		);
		const conversationId = convo.rows[0]?.conversation_id;
		if (!conversationId) return;
		await db.query(`UPDATE tasks SET origin_chat_conversation_id = $2 WHERE id = $1`, [
			task.id,
			conversationId,
		]);
		const projectId = typeof task.project_id === 'string' ? task.project_id : null;
		const project = projectId
			? await db.query<{ name: string }>(`SELECT name FROM projects WHERE id = $1`, [projectId])
			: null;
		const where = project?.rows[0]?.name ? ` in ${project.rows[0].name}` : '';
		const title = typeof task.title === 'string' && task.title ? `: ${task.title}` : '';
		await postChatSystemMessage(
			db,
			wsManager,
			conversationId,
			ChatSystemMessageKind.TaskCreated,
			`Created task ${task.identifier}${where}${title}`,
		);
	} catch (e) {
		log.error('failed to record a chat task origin', e);
	}
}

/**
 * The completion / blocked receipts, fired from the status automations so both
 * the REST close and the MCP `update_task` path emit them. Only transitions a
 * person waits on get a row - done ("your ask landed") and blocked ("it needs
 * you") - and only for tasks born in a chat. Best-effort, like every automation
 * leg: a receipt must not fail a status change.
 */
export async function postTaskStatusBreadcrumb(
	db: Db,
	wsManager: WebSocketManager | undefined,
	taskId: string,
	newStatus: string,
): Promise<void> {
	if (newStatus !== TaskStatus.Done && newStatus !== TaskStatus.Blocked) return;
	try {
		const task = await db.query<{
			identifier: string;
			title: string;
			origin_chat_conversation_id: string | null;
		}>(`SELECT identifier, title, origin_chat_conversation_id FROM tasks WHERE id = $1`, [taskId]);
		const row = task.rows[0];
		if (!row?.origin_chat_conversation_id) return;
		const [kind, content] =
			newStatus === TaskStatus.Done
				? [ChatSystemMessageKind.TaskCompleted, `Task ${row.identifier} completed: ${row.title}`]
				: [
						ChatSystemMessageKind.TaskBlocked,
						`Task ${row.identifier} is blocked and needs you: ${row.title}`,
					];
		await postChatSystemMessage(db, wsManager, row.origin_chat_conversation_id, kind, content);
	} catch (e) {
		log.error('failed to post a task status breadcrumb', e);
	}
}
