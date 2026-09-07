import {
	AgentAdminStatus,
	ATTACHMENT_MAX_BYTES,
	AuthType,
	CAPTAIN_AGENT_SLUG,
	CHAT_MESSAGE_PREVIEW_CHARS,
	CHAT_UPLOADS_FOLDER,
	ChatChannel,
	ChatSystemMessageKind,
	DEFAULT_TEAM_ID,
	WsMessageType,
	wsRoom,
} from '@hezo/shared';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { loadChatMessageAttachments } from '../lib/chat-attachments';
import { buildCursorPage, decodeCursor, encodeCursor } from '../lib/pagination';
import { isUuid } from '../lib/resolve';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { postChatSystemMessage } from '../services/chat-breadcrumbs';
import { hoursQuotaExhausted } from '../services/run-concurrency';
import { CreateTaskError, createTask } from '../services/tasks';
import { readUploadForm, storeUploadedAsset } from './assets';
import {
	deriveConvertTaskFields,
	MAX_BATCH_MESSAGES,
	MESSAGE_COLUMNS,
	parseMessageBatch,
} from './chat';
import { buildCreateTaskCaller } from './tasks';

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
// switcher. Bounded in rows by the roster and in width by the preview-char
// preview; the full message set comes from the single-conversation read.
projectChatRoutes.get('/projects/:projectId/chat/conversations', async (c) => {
	const teamId = c.get('teamId') as string;
	const projectId = c.get('projectId') as string;
	const auth = c.get('auth');
	const userId = auth.type === AuthType.Admin ? (auth.userId ?? null) : null;
	// HQ's roster is the instance singletons; its chat surface is the global CEO
	// chat, not a per-project DM list.
	if (teamId === DEFAULT_TEAM_ID) {
		return ok(c, { team_id: teamId, conversations: [], groups: [], groups_next_cursor: null });
	}
	const rows = await c.get('db').query<Record<string, unknown>>(
		`SELECT m.id AS member_id, ma.slug, ma.title, m.display_name,
		        c2.id AS conversation_id, c2.last_activity_at, c2.last_message_id,
		        LEFT(lm.content, ${CHAT_MESSAGE_PREVIEW_CHARS}) AS last_message_preview,
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

	// The project's group rooms, with the built-in General ensured (and
	// roster-synced) on the way through. Keyset-paged ascending on
	// (created_at, id) — General is the oldest group row by construction, so it
	// leads page one — because a bare limit would drop rooms silently.
	await ensureGeneralRoom(c, teamId, projectId);
	const cursor = decodeCursor(c.req.query('group_cursor') ?? undefined);
	const cursorValid =
		cursor !== null && isUuid(cursor.id) && !Number.isNaN(Date.parse(cursor.value));
	const groupLimit = 50;
	const groupRows = await c.get('db').query<Record<string, unknown> & { id: string }>(
		`SELECT g.id, g.title, g.is_general, g.created_at, g.last_activity_at, g.last_message_id,
		        LEFT(lm.content, ${CHAT_MESSAGE_PREVIEW_CHARS}) AS last_message_preview,
		        lm.role::text AS last_message_role,
		        COALESCE(lm.author_label, '') AS last_message_author,
		        (g.last_message_id IS NOT NULL
		          AND ($3::uuid IS NULL OR r.last_read_message_id IS DISTINCT FROM g.last_message_id)
		          AND (lm.role IS DISTINCT FROM 'user')) AS unread,
		        COALESCE(p.participants, '[]'::json) AS participants
		   FROM chat_conversations g
		   LEFT JOIN chat_messages lm ON lm.id = g.last_message_id
		   LEFT JOIN chat_conversation_reads r
		     ON r.conversation_id = g.id AND r.user_id = $3::uuid
		   LEFT JOIN LATERAL (
		     SELECT json_agg(json_build_object(
		              'member_id', pp.member_id, 'slug', ma.slug, 'title', ma.title,
		              'display_name', m.display_name) ORDER BY ma.title) AS participants
		     FROM chat_conversation_participants pp
		     JOIN members m ON m.id = pp.member_id
		     JOIN member_agents ma ON ma.id = pp.member_id
		     WHERE pp.conversation_id = g.id AND ma.admin_status = $4::agent_admin_status
		   ) p ON true
		  WHERE g.project_id = $2 AND g.team_id = $1 AND g.kind = 'group' AND g.closed_at IS NULL
		    AND ($5::timestamptz IS NULL OR (g.created_at, g.id) > ($5::timestamptz, $6::uuid))
		  ORDER BY g.created_at ASC, g.id ASC
		  LIMIT ${groupLimit + 1}`,
		[
			teamId,
			projectId,
			userId,
			AgentAdminStatus.Enabled,
			cursorValid ? cursor.value : null,
			cursorValid ? cursor.id : null,
		],
	);
	const page = buildCursorPage(groupRows.rows, groupLimit, (row) =>
		encodeCursor(new Date(row.created_at as string).toISOString(), row.id),
	);
	return ok(c, {
		// The team's chat signal room is keyed by this - the client joins
		// `chat:team:<id>` off the list it renders badges for.
		team_id: teamId,
		conversations: rows.rows,
		groups: page.data,
		groups_next_cursor: page.meta.next_cursor,
	});
});

/**
 * Lazily provision this project's built-in General room and keep its
 * membership synced to the roster. Runs on the list read rather than on
 * hire/fire hooks, so an upgraded instance gains the room with no migration
 * and roster changes converge on the next look; every statement no-ops when
 * nothing changed.
 */
async function ensureGeneralRoom(
	c: Context<Env>,
	teamId: string,
	projectId: string,
): Promise<void> {
	const db = c.get('db');
	await db.query(
		`INSERT INTO chat_conversations (team_id, project_id, channel, kind, is_general, title)
		 VALUES ($1, $2, 'web', 'group', true, 'General')
		 ON CONFLICT (project_id) WHERE is_general DO NOTHING`,
		[teamId, projectId],
	);
	const general = await db.query<{ id: string }>(
		`SELECT id FROM chat_conversations WHERE project_id = $1 AND is_general`,
		[projectId],
	);
	const generalId = general.rows[0]?.id;
	if (!generalId) return;
	await db.query(
		`INSERT INTO chat_conversation_participants (conversation_id, member_id)
		 SELECT $1, m.id FROM members m JOIN member_agents ma ON ma.id = m.id
		 WHERE m.team_id = $2 AND ma.admin_status = $3::agent_admin_status
		 ON CONFLICT DO NOTHING`,
		[generalId, teamId, AgentAdminStatus.Enabled],
	);
	await db.query(
		`DELETE FROM chat_conversation_participants p
		 WHERE p.conversation_id = $1
		   AND NOT EXISTS (
		     SELECT 1 FROM members m JOIN member_agents ma ON ma.id = m.id
		     WHERE m.id = p.member_id AND m.team_id = $2
		       AND ma.admin_status = $3::agent_admin_status)`,
		[generalId, teamId, AgentAdminStatus.Enabled],
	);
}

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
		// See the CEO read: the composer warns from the same predicate admission
		// uses, so nobody types a message that cannot start a container.
		hours_exhausted: await hoursQuotaExhausted(db),
	});
});

/**
 * Every attachment on a send must be this project's own asset (uploaded via
 * the project chat upload below) - never another project's, never HQ's.
 * Returns whether the whole batch checks out.
 */
async function validateChatAttachments(
	c: Context<Env>,
	batch: Array<{ attachmentIds: string[] }>,
): Promise<boolean> {
	const allAttachmentIds = batch.flatMap((m) => m.attachmentIds);
	if (allAttachmentIds.length === 0) return true;
	const matched = await c
		.get('db')
		.query<{ id: string }>(
			`SELECT DISTINCT id FROM assets WHERE id = ANY($1::uuid[]) AND project_id = $2`,
			[allAttachmentIds, c.get('projectId') as string],
		);
	return matched.rows.length === new Set(allAttachmentIds).size;
}

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
	if (!(await validateChatAttachments(c, batch))) {
		return err(c, 'BAD_REQUEST', 'One or more attachments are invalid', 400);
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

/**
 * Resolve a group room by id, bound to this request's project AND team - the
 * route params are never trusted alone. Null when it does not exist here (or
 * the id is not even uuid-shaped, which must 404 rather than 500).
 */
async function resolveGroupConversation(
	c: Context<Env>,
	conversationId: string,
): Promise<{ id: string; is_general: boolean; title: string | null } | null> {
	if (!isUuid(conversationId)) return null;
	const r = await c.get('db').query<{ id: string; is_general: boolean; title: string | null }>(
		`SELECT id, is_general, title FROM chat_conversations
		 WHERE id = $1 AND project_id = $2 AND team_id = $3
		   AND kind = 'group' AND closed_at IS NULL`,
		[conversationId, c.get('projectId') as string, c.get('teamId') as string],
	);
	return r.rows[0] ?? null;
}

/**
 * Resolve participant slugs to enabled roster members of this team. Returns
 * null when any slug does not resolve - membership is all-or-nothing, so a
 * typo cannot quietly create a smaller room. Team scoping structurally
 * excludes the CEO and Coach (instance singletons live outside project teams).
 */
async function resolveParticipantSlugs(
	c: Context<Env>,
	slugs: string[],
): Promise<Array<{ id: string; slug: string }> | null> {
	const unique = [...new Set(slugs)];
	if (unique.length === 0) return null;
	const r = await c.get('db').query<{ id: string; slug: string }>(
		`SELECT m.id, ma.slug FROM members m JOIN member_agents ma ON ma.id = m.id
		 WHERE m.team_id = $1 AND ma.slug = ANY($2::text[])
		   AND ma.admin_status = $3::agent_admin_status`,
		[c.get('teamId') as string, unique, AgentAdminStatus.Enabled],
	);
	return r.rows.length === unique.length ? r.rows : null;
}

/** Longest accepted group-room name; matches the DM auto-title bound. */
const GROUP_TITLE_MAX_CHARS = 120;

// Create a group room. Participants are explicit (the built-in General room is
// provisioned by the list read instead) and validated against the enabled
// roster of this project's team.
projectChatRoutes.post('/projects/:projectId/chat/groups', async (c) => {
	const teamId = c.get('teamId') as string;
	const projectId = c.get('projectId') as string;
	if (teamId === DEFAULT_TEAM_ID) return err(c, 'NOT_FOUND', 'HQ has no group rooms', 404);
	const body = await c.req.json().catch(() => ({}));
	const title = typeof body.title === 'string' ? body.title.trim() : '';
	const slugs = Array.isArray(body.participant_slugs)
		? body.participant_slugs.filter((s: unknown): s is string => typeof s === 'string')
		: [];
	if (!title) return err(c, 'BAD_REQUEST', 'A room name is required', 400);
	if (title.length > GROUP_TITLE_MAX_CHARS) {
		return err(
			c,
			'BAD_REQUEST',
			`Room name is limited to ${GROUP_TITLE_MAX_CHARS} characters`,
			400,
		);
	}
	const participants = await resolveParticipantSlugs(c, slugs);
	if (!participants) {
		return err(
			c,
			'BAD_REQUEST',
			'Participants must be one or more enabled agents of this project team',
			400,
		);
	}
	const db = c.get('db');
	const created = await db.query<{ id: string }>(
		`INSERT INTO chat_conversations (team_id, project_id, channel, kind, title)
		 VALUES ($1, $2, 'web', 'group', $3) RETURNING id`,
		[teamId, projectId, title],
	);
	const conversationId = created.rows[0].id;
	await db.query(
		`INSERT INTO chat_conversation_participants (conversation_id, member_id)
		 SELECT $1, member_id FROM UNNEST($2::uuid[]) AS member_id`,
		[conversationId, participants.map((p) => p.id)],
	);
	return ok(c, { conversation_id: conversationId, title }, 201);
});

// One group room's history: the active window plus the room's own metadata and
// participant roster (the structural fields the client reasons about).
projectChatRoutes.get('/projects/:projectId/chat/groups/:conversationId', async (c) => {
	const group = await resolveGroupConversation(c, c.req.param('conversationId'));
	if (!group) return err(c, 'NOT_FOUND', 'group room not found', 404);
	const db = c.get('db');
	const messages = await db.query<Record<string, unknown>>(
		`SELECT ${MESSAGE_COLUMNS}, author_label FROM chat_messages
		 WHERE conversation_id = $1 AND compacted_at IS NULL
		 ORDER BY created_at ASC`,
		[group.id],
	);
	const compacted = await db.query<{ count: number }>(
		`SELECT COUNT(*)::int AS count FROM chat_messages
		 WHERE conversation_id = $1 AND compacted_at IS NOT NULL`,
		[group.id],
	);
	const participants = await db.query<Record<string, unknown>>(
		`SELECT p.member_id, ma.slug, ma.title, m.display_name
		 FROM chat_conversation_participants p
		 JOIN members m ON m.id = p.member_id
		 JOIN member_agents ma ON ma.id = p.member_id
		 WHERE p.conversation_id = $1 AND ma.admin_status = $2::agent_admin_status
		 ORDER BY ma.title ASC`,
		[group.id, AgentAdminStatus.Enabled],
	);
	const ids = messages.rows.map((r) => r.id as string);
	const byMessage = await loadChatMessageAttachments(db, ids, c.get('masterKeyManager'));
	return ok(c, {
		conversation_id: group.id,
		title: group.title,
		is_general: group.is_general,
		// Replay of the pending strip: broadcasts only reach whoever was
		// subscribed when the queue changed.
		pending_turns: c.get('chatSessionManager')?.groupPendingTurns(group.id) ?? [],
		participants: participants.rows,
		messages: messages.rows.map((r) => ({
			...r,
			attachments: byMessage.get(r.id as string) ?? [],
		})),
		compacted_count: compacted.rows[0]?.count ?? 0,
		hours_exhausted: await hoursQuotaExhausted(db),
	});
});

// Rename a room and/or edit its participants. The General room renames but
// never edits membership - its roster is synced from the team by the list
// read, and an edit here would be silently undone there.
projectChatRoutes.patch('/projects/:projectId/chat/groups/:conversationId', async (c) => {
	const group = await resolveGroupConversation(c, c.req.param('conversationId'));
	if (!group) return err(c, 'NOT_FOUND', 'group room not found', 404);
	const body = await c.req.json().catch(() => ({}));
	const db = c.get('db');

	let title: string | null = null;
	if (body.title !== undefined) {
		title = typeof body.title === 'string' ? body.title.trim() : '';
		if (!title) return err(c, 'BAD_REQUEST', 'A room name is required', 400);
		if (title.length > GROUP_TITLE_MAX_CHARS) {
			return err(
				c,
				'BAD_REQUEST',
				`Room name is limited to ${GROUP_TITLE_MAX_CHARS} characters`,
				400,
			);
		}
	}

	let participants: Array<{ id: string; slug: string }> | null = null;
	if (body.participant_slugs !== undefined) {
		if (group.is_general) {
			return err(c, 'BAD_REQUEST', 'The General room always contains the whole team', 400);
		}
		const slugs = Array.isArray(body.participant_slugs)
			? body.participant_slugs.filter((s: unknown): s is string => typeof s === 'string')
			: [];
		participants = await resolveParticipantSlugs(c, slugs);
		if (!participants) {
			return err(
				c,
				'BAD_REQUEST',
				'Participants must be one or more enabled agents of this project team',
				400,
			);
		}
	}

	if (title !== null) {
		await db.query(
			`UPDATE chat_conversations SET title = $2 WHERE id = $1 AND title IS DISTINCT FROM $2`,
			[group.id, title],
		);
	}
	if (participants !== null) {
		const keep = participants.map((p) => p.id);
		await db.query(
			`INSERT INTO chat_conversation_participants (conversation_id, member_id)
			 SELECT $1, member_id FROM UNNEST($2::uuid[]) AS member_id
			 ON CONFLICT DO NOTHING`,
			[group.id, keep],
		);
		await db.query(
			`DELETE FROM chat_conversation_participants
			 WHERE conversation_id = $1 AND NOT (member_id = ANY($2::uuid[]))`,
			[group.id, keep],
		);
	}
	// Tell open switchers/lists to refetch; same fanout as the breadcrumb writer
	// (the room's own subscribers plus the team's signal room).
	const wsManager = c.get('wsManager');
	if (wsManager && (title !== null || participants !== null)) {
		const message = {
			type: WsMessageType.ChatConversationUpdated,
			conversationId: group.id,
			...(title !== null ? { title } : {}),
		};
		wsManager.broadcast(wsRoom.chatConversation(group.id), { ...message });
		wsManager.broadcast(wsRoom.chatTeam(c.get('teamId') as string), { ...message });
	}
	return ok(c, { conversation_id: group.id, title: title ?? group.title });
});

// Send an operator turn into a group room. Same batch shape as the DM send;
// the response carries the server-resolved pending queue - empty means no
// mention and no locus, and the client shows its local "tag a teammate" nudge.
projectChatRoutes.post('/projects/:projectId/chat/groups/:conversationId/messages', async (c) => {
	const teamId = c.get('teamId') as string;
	const projectId = c.get('projectId') as string;
	const manager = c.get('chatSessionManager');
	if (!manager) return err(c, 'UNAVAILABLE', 'chat is not available', 503);
	const group = await resolveGroupConversation(c, c.req.param('conversationId'));
	if (!group) return err(c, 'NOT_FOUND', 'group room not found', 404);

	const body = await c.req.json().catch(() => ({}));
	const batch = parseMessageBatch(body);
	if (!batch) return err(c, 'BAD_REQUEST', 'Message text or an attachment is required', 400);
	if (batch.length > MAX_BATCH_MESSAGES) {
		return err(c, 'BAD_REQUEST', `At most ${MAX_BATCH_MESSAGES} messages per turn`, 400);
	}
	if (!(await validateChatAttachments(c, batch))) {
		return err(c, 'BAD_REQUEST', 'One or more attachments are invalid', 400);
	}

	const auth = c.get('auth');
	const authorUserId = auth.type === AuthType.Admin ? auth.userId : null;
	try {
		const result = await manager.sendGroupTurn({
			conversationId: group.id,
			teamId,
			projectId,
			text: batch[0].text,
			authorUserId,
			messages: batch,
		});
		return ok(
			c,
			{
				user_message_id: result.userMessageId,
				user_message_ids: result.userMessageIds,
				conversation_id: result.conversationId,
				pending_member_ids: result.pendingMemberIds,
			},
			201,
		);
	} catch (e) {
		return err(c, 'CHAT_UNAVAILABLE', (e as Error).message, 503);
	}
});

// Cancel one still-pending reply in a room's queue (a chip on the pending
// strip). A turn that already started streaming is interrupted by a newer
// message instead, exactly like a DM.
projectChatRoutes.post(
	'/projects/:projectId/chat/groups/:conversationId/cancel-turn',
	async (c) => {
		const manager = c.get('chatSessionManager');
		if (!manager) return err(c, 'UNAVAILABLE', 'chat is not available', 503);
		const group = await resolveGroupConversation(c, c.req.param('conversationId'));
		if (!group) return err(c, 'NOT_FOUND', 'group room not found', 404);
		const body = await c.req.json().catch(() => ({}));
		const memberId = typeof body.member_id === 'string' ? body.member_id : '';
		if (!isUuid(memberId)) return err(c, 'BAD_REQUEST', 'member_id is required', 400);
		return ok(c, { cancelled: manager.cancelGroupPendingTurn(group.id, memberId) });
	},
);

// Convert one chat message into a task - the conversation survives (never the
// closed-thread conversion the old CEO threads had). Assignee defaults to the
// DM partner in a DM and to the Captain in a group room; the picker can name
// any enabled roster agent. The task is stamped with its origin conversation,
// so the standard created/completed/blocked breadcrumbs flow back here.
projectChatRoutes.post(
	'/projects/:projectId/chat/conversations/:conversationId/convert',
	async (c) => {
		const teamId = c.get('teamId') as string;
		const projectId = c.get('projectId') as string;
		const conversationId = c.req.param('conversationId');
		if (!isUuid(conversationId)) return err(c, 'NOT_FOUND', 'conversation not found', 404);
		const db = c.get('db');
		const convo = await db.query<{ id: string; kind: string; member_id: string | null }>(
			`SELECT id, kind::text AS kind, member_id FROM chat_conversations
			 WHERE id = $1 AND project_id = $2 AND team_id = $3 AND kind IN ('assistant', 'group')`,
			[conversationId, projectId, teamId],
		);
		if (!convo.rows[0]) return err(c, 'NOT_FOUND', 'conversation not found', 404);

		const body = await c.req.json().catch(() => ({}));
		const messageId = typeof body.message_id === 'string' ? body.message_id : '';
		if (!isUuid(messageId)) return err(c, 'BAD_REQUEST', 'message_id is required', 400);
		const message = await db.query<{ content: string; role: string; author_label: string | null }>(
			`SELECT content, role::text AS role, author_label FROM chat_messages
			 WHERE id = $1 AND conversation_id = $2`,
			[messageId, conversationId],
		);
		if (!message.rows[0]) return err(c, 'BAD_REQUEST', 'message not in this conversation', 400);

		// Assignee: explicit pick, else the DM partner, else the Captain.
		const assigneeSlug =
			typeof body.assignee_slug === 'string' && body.assignee_slug !== ''
				? body.assignee_slug
				: null;
		let assigneeId: string | null = null;
		if (!assigneeSlug && convo.rows[0].kind === 'assistant') {
			assigneeId = convo.rows[0].member_id;
		}

		const fields = deriveConvertTaskFields(message.rows[0], body.title);
		if (!fields) return err(c, 'BAD_REQUEST', 'A task title is required', 400);

		const caller = await buildCreateTaskCaller(c, teamId);
		let task: Awaited<ReturnType<typeof createTask>>;
		try {
			task = await createTask(
				db,
				teamId,
				{
					project_id: projectId,
					title: fields.title,
					description: fields.description,
					...(assigneeId
						? { assignee_id: assigneeId }
						: { assignee_slug: assigneeSlug ?? CAPTAIN_AGENT_SLUG }),
				},
				caller,
				c.get('wsManager'),
				c.get('events'),
			);
		} catch (e) {
			if (e instanceof CreateTaskError) {
				const status = e.code === 'NOT_FOUND' ? 404 : e.code === 'FORBIDDEN' ? 403 : 400;
				return err(c, e.code, e.message, status);
			}
			throw e;
		}
		// Stamp the origin and drop the created receipt, so the standard
		// completed/blocked breadcrumbs find their way back to this conversation.
		await db.query(`UPDATE tasks SET origin_chat_conversation_id = $2 WHERE id = $1`, [
			task.id,
			conversationId,
		]);
		await postChatSystemMessage(
			db,
			c.get('wsManager'),
			conversationId,
			ChatSystemMessageKind.TaskCreated,
			`Created task ${task.identifier}: ${fields.title}`,
		);
		return ok(c, task, 201);
	},
);

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
