import {
	AgentAdminStatus,
	ATTACHMENT_MAX_BYTES,
	AuthType,
	CHAT_UPLOADS_FOLDER,
	ChatChannel,
	DEFAULT_TEAM_ID,
} from '@hezo/shared';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { loadChatMessageAttachments } from '../lib/chat-attachments';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { readUploadForm, storeUploadedAsset } from './assets';
import { MAX_BATCH_MESSAGES, MESSAGE_COLUMNS, parseMessageBatch } from './chat';

/**
 * Per-project agent DMs: the operator chatting with a project's own roster.
 * Everything here runs behind `requireProjectAccessMiddleware` (mounted on
 * `/api/projects/:projectId/*`), and every query still binds the conversation
 * to the resolved project AND team in its WHERE - the route params alone are
 * never trusted to scope a read.
 *
 * The CEO chat is deliberately not reachable here: it is instance-wide and
 * stays on the global `/api/chat/*` routes, which are constrained to HQ.
 *
 * These routes have NO MCP twins (the precedent is documented in
 * routes/connectors.ts): the DM surface is the human operator's; agents speak
 * in it only as the replying party, through the session manager.
 */
export const projectChatRoutes = new Hono<Env>();

/** Resolve an enabled agent of this project's team by slug. */
async function resolveProjectAgent(
	c: Context<Env>,
	slug: string,
): Promise<{ memberId: string } | null> {
	const r = await c.get('db').query<{ id: string }>(
		`SELECT m.id FROM members m JOIN member_agents ma ON ma.id = m.id
		 WHERE m.team_id = $1 AND ma.slug = $2 AND ma.admin_status = $3::agent_admin_status`,
		[c.get('teamId') as string, slug, AgentAdminStatus.Enabled],
	);
	return r.rows[0] ? { memberId: r.rows[0].id } : null;
}

// The project's DM list: one row per enabled roster agent, with its open
// conversation (when one exists), a bounded preview of the newest message, and
// the caller's unread bit. Drives the project menu's chat cards and the dock
// switcher. Bounded in rows by the roster and in width by the 140-char
// preview; the full message set comes from the single-conversation read.
projectChatRoutes.get('/projects/:projectId/chat/conversations', async (c) => {
	const teamId = c.get('teamId') as string;
	const projectId = c.get('projectId') as string;
	const auth = c.get('auth');
	const userId = auth.type === AuthType.Admin ? (auth.userId ?? null) : null;
	// HQ's roster is the instance singletons; its chat surface is the global CEO
	// chat, not a per-project DM list.
	if (teamId === DEFAULT_TEAM_ID) return ok(c, { conversations: [] });
	const rows = await c.get('db').query<Record<string, unknown>>(
		`SELECT m.id AS member_id, ma.slug, ma.title, m.display_name,
		        c2.id AS conversation_id, c2.last_activity_at, c2.last_message_id,
		        LEFT(lm.content, 140) AS last_message_preview,
		        lm.role::text AS last_message_role,
		        (c2.last_message_id IS NOT NULL
		          AND ($3::uuid IS NULL OR r.last_read_message_id IS DISTINCT FROM c2.last_message_id)
		          AND (lm.role IS DISTINCT FROM 'user')) AS unread
		   FROM members m
		   JOIN member_agents ma ON ma.id = m.id
		   LEFT JOIN LATERAL (
		     SELECT id, last_activity_at, last_message_id FROM chat_conversations cc
		      WHERE cc.member_id = m.id AND cc.project_id = $2 AND cc.team_id = $1
		        AND cc.channel = 'web' AND cc.external_thread_id IS NULL AND cc.closed_at IS NULL
		      ORDER BY cc.last_activity_at DESC, cc.created_at DESC LIMIT 1
		   ) c2 ON true
		   LEFT JOIN chat_messages lm ON lm.id = c2.last_message_id
		   LEFT JOIN chat_conversation_reads r
		     ON r.conversation_id = c2.id AND r.user_id = $3::uuid
		  WHERE m.team_id = $1 AND ma.admin_status = $4::agent_admin_status
		  ORDER BY ma.title ASC`,
		[teamId, projectId, userId, AgentAdminStatus.Enabled],
	);
	return ok(c, { conversations: rows.rows });
});

// One agent DM's history: the active (non-compacted) window, like the CEO
// conversation read. A DM that has never been written to answers empty rather
// than 404 - the roster is the list, and the stream is created lazily on the
// first send.
projectChatRoutes.get('/projects/:projectId/chat/agents/:agentSlug/conversation', async (c) => {
	const teamId = c.get('teamId') as string;
	const projectId = c.get('projectId') as string;
	const agent = await resolveProjectAgent(c, c.req.param('agentSlug'));
	if (!agent) return err(c, 'NOT_FOUND', 'agent not found', 404);
	const db = c.get('db');
	const convo = await db.query<{ id: string }>(
		`SELECT id FROM chat_conversations
		 WHERE member_id = $1 AND project_id = $2 AND team_id = $3
		   AND channel = 'web' AND external_thread_id IS NULL AND closed_at IS NULL
		 ORDER BY last_activity_at DESC, created_at DESC LIMIT 1`,
		[agent.memberId, projectId, teamId],
	);
	const conversationId = convo.rows[0]?.id ?? null;
	if (!conversationId) {
		return ok(c, { conversation_id: null, messages: [], compacted_count: 0 });
	}
	const messages = await db.query<Record<string, unknown>>(
		`SELECT ${MESSAGE_COLUMNS} FROM chat_messages
		 WHERE conversation_id = $1 AND compacted_at IS NULL
		 ORDER BY created_at ASC`,
		[conversationId],
	);
	const compacted = await db.query<{ count: number }>(
		`SELECT COUNT(*)::int AS count FROM chat_messages
		 WHERE conversation_id = $1 AND compacted_at IS NOT NULL`,
		[conversationId],
	);
	const ids = messages.rows.map((r) => r.id as string);
	const byMessage = await loadChatMessageAttachments(db, ids, c.get('masterKeyManager'));
	return ok(c, {
		conversation_id: conversationId,
		messages: messages.rows.map((r) => ({
			...r,
			attachments: byMessage.get(r.id as string) ?? [],
		})),
		compacted_count: compacted.rows[0]?.count ?? 0,
	});
});

// Send a turn to an agent's DM. Same batch shape as the CEO send; the reply
// streams over the conversation's WS room.
projectChatRoutes.post('/projects/:projectId/chat/agents/:agentSlug/messages', async (c) => {
	const teamId = c.get('teamId') as string;
	const projectId = c.get('projectId') as string;
	const manager = c.get('chatSessionManager');
	if (!manager) return err(c, 'UNAVAILABLE', 'chat is not available', 503);
	const agent = await resolveProjectAgent(c, c.req.param('agentSlug'));
	if (!agent) return err(c, 'NOT_FOUND', 'agent not found', 404);

	const body = await c.req.json().catch(() => ({}));
	const batch = parseMessageBatch(body);
	if (!batch) return err(c, 'BAD_REQUEST', 'Message text or an attachment is required', 400);
	if (batch.length > MAX_BATCH_MESSAGES) {
		return err(c, 'BAD_REQUEST', `At most ${MAX_BATCH_MESSAGES} messages per turn`, 400);
	}

	// Every attachment must be this project's own asset (uploaded via the
	// project chat upload below) - never another project's, never HQ's.
	const allAttachmentIds = batch.flatMap((m) => m.attachmentIds);
	if (allAttachmentIds.length > 0) {
		const matched = await c
			.get('db')
			.query<{ id: string }>(
				`SELECT DISTINCT id FROM assets WHERE id = ANY($1::uuid[]) AND project_id = $2`,
				[allAttachmentIds, projectId],
			);
		if (matched.rows.length !== new Set(allAttachmentIds).size) {
			return err(c, 'BAD_REQUEST', 'One or more attachments are invalid', 400);
		}
	}

	const auth = c.get('auth');
	const authorUserId = auth.type === AuthType.Admin ? auth.userId : null;
	const conversationId =
		typeof body.conversation_id === 'string' ? body.conversation_id : undefined;

	try {
		const result = await manager.sendWorkerTurn({
			memberId: agent.memberId,
			teamId,
			projectId,
			conversationId,
			text: batch[0].text,
			authorUserId,
			messages: batch,
		});
		return ok(
			c,
			{
				user_message_id: result.userMessageId,
				user_message_ids: result.userMessageIds,
				assistant_message_id: result.assistantMessageId,
				conversation_id: result.conversationId,
			},
			201,
		);
	} catch (e) {
		return err(c, 'CHAT_UNAVAILABLE', (e as Error).message, 503);
	}
});

// Upload a file for a project DM. Stored in this project's asset library under
// `uploads/chat/`; the returned asset id rides a later send's attachment_ids.
projectChatRoutes.post(
	'/projects/:projectId/chat/assets',
	bodyLimit({
		maxSize: ATTACHMENT_MAX_BYTES,
		onError: (c) => err(c, 'TOO_LARGE', 'Attachment exceeds 10 MB', 400),
	}),
	async (c) => {
		const upload = await readUploadForm(c);
		if (!upload) return err(c, 'INVALID_REQUEST', 'Missing file field', 400);
		return storeUploadedAsset(
			c,
			c.get('teamId') as string,
			c.get('projectId') as string,
			upload.file,
			null,
			CHAT_UPLOADS_FOLDER,
		);
	},
);
