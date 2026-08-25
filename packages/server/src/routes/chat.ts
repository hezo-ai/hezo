import {
	ATTACHMENT_MAX_BYTES,
	AuthType,
	CHAT_UPLOADS_FOLDER,
	ChatChannel,
	ChatConversationKind,
	DEFAULT_TEAM_ID,
} from '@hezo/shared';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Db } from '../db/database';
import { loadChatMessageAttachments } from '../lib/chat-attachments';
import {
	actorTypeFromAuth,
	apiKeyIdFromAuth,
	resolveActorMemberId,
	resolveProject,
} from '../lib/resolve';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { requireAdminEquivalent, requireTeamAccessForResource } from '../middleware/auth';
import { ChatConvertError } from '../services/chat-session-manager';
import { CreateTaskError } from '../services/tasks';
import { readUploadForm, storeUploadedAsset } from './assets';

export const chatRoutes = new Hono<Env>();

export const MESSAGE_COLUMNS = `id, conversation_id, role, channel, status, content, author_user_id,
	author_member_id, suggested_replies, input_tokens, output_tokens, cost_cents, error, system_kind,
	created_at, completed_at`;

/**
 * The CEO chat is instance-wide (one global conversation), so these are global
 * endpoints gated on access to the HQ team rather than a `:teamId` route param.
 */
function authorize(c: Context<Env>): Promise<{ teamId: string } | Response> {
	return requireTeamAccessForResource(c.get('db'), c, DEFAULT_TEAM_ID);
}

/** The HQ (is_internal) project — chat files and message attachments live here. */
async function resolveHqProjectId(db: Db): Promise<string | null> {
	const r = await db.query<{ id: string }>(
		`SELECT id FROM projects WHERE team_id = $1 AND is_internal = true`,
		[DEFAULT_TEAM_ID],
	);
	return r.rows[0]?.id ?? null;
}

/**
 * Resolve the target conversation for a request: an explicit `conversation_id`
 * (validated to exist), or the default web thread. Returns null when an explicit
 * id doesn't resolve, so the caller can 404.
 */
async function resolveConversationId(
	c: Context<Env>,
	explicit: string | undefined,
): Promise<string | null> {
	const manager = c.get('chatSessionManager');
	if (!manager) return null;
	if (explicit) {
		const convo = await manager.getConversation(explicit);
		// The global routes are the CEO/HQ surface only: a project DM lives under
		// its own `/api/projects/:projectId/chat/*` routes and their per-project
		// authorization, so an HQ-authorized read must not reach it from here.
		return convo && convo.team_id === DEFAULT_TEAM_ID ? convo.id : null;
	}
	return manager.getConversationId();
}

/** Merge each message's file attachments (signed URLs) onto the row for the client. */
async function withAttachments(
	c: Context<Env>,
	rows: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
	const ids = rows.map((r) => r.id as string);
	const byMessage = await loadChatMessageAttachments(c.get('db'), ids, c.get('masterKeyManager'));
	return rows.map((r) => ({ ...r, attachments: byMessage.get(r.id as string) ?? [] }));
}

chatRoutes.get('/chat/conversation', async (c) => {
	const access = await authorize(c);
	if (access instanceof Response) return access;

	const manager = c.get('chatSessionManager');
	if (!manager) return err(c, 'UNAVAILABLE', 'CEO chat is not available', 503);
	const conversationId = await resolveConversationId(c, c.req.query('conversation_id'));
	if (!conversationId) return err(c, 'NOT_FOUND', 'conversation not found', 404);

	// The chatbox shows the active window — the non-compacted messages. Older
	// messages have been summarized into long-term memory and dropped. The window
	// is bounded by compaction, so the full active set is returned (no limit).
	const db = c.get('db');
	const messages = await db.query<Record<string, unknown>>(
		`SELECT ${MESSAGE_COLUMNS} FROM chat_messages
			 WHERE conversation_id = $1 AND compacted_at IS NULL
			 ORDER BY created_at ASC`,
		[conversationId],
	);
	// How many older messages were compacted away — drives the "chat compacted"
	// marker the chatbox shows at the top of the window.
	const compacted = await db.query<{ count: number }>(
		`SELECT COUNT(*)::int AS count FROM chat_messages
			 WHERE conversation_id = $1 AND compacted_at IS NOT NULL`,
		[conversationId],
	);
	return ok(c, {
		conversation_id: conversationId,
		messages: await withAttachments(c, messages.rows),
		compacted_count: compacted.rows[0]?.count ?? 0,
	});
});

chatRoutes.get('/chat/messages', async (c) => {
	const access = await authorize(c);
	if (access instanceof Response) return access;

	const manager = c.get('chatSessionManager');
	if (!manager) return err(c, 'UNAVAILABLE', 'CEO chat is not available', 503);
	const conversationId = await resolveConversationId(c, c.req.query('conversation_id'));
	if (!conversationId) return err(c, 'NOT_FOUND', 'conversation not found', 404);

	const limit = clampLimit(c.req.query('limit'));
	const before = c.req.query('before');
	const rows = before
		? await c.get('db').query<Record<string, unknown>>(
				`SELECT ${MESSAGE_COLUMNS} FROM chat_messages
				 WHERE conversation_id = $1 AND compacted_at IS NULL AND created_at < $2
				 ORDER BY created_at DESC LIMIT $3`,
				[conversationId, before, limit],
			)
		: await c.get('db').query<Record<string, unknown>>(
				`SELECT ${MESSAGE_COLUMNS} FROM chat_messages
				 WHERE conversation_id = $1 AND compacted_at IS NULL
				 ORDER BY created_at DESC LIMIT $2`,
				[conversationId, limit],
			);
	return ok(c, { messages: await withAttachments(c, rows.rows.reverse()) });
});

// Upload a file for the realtime chatbox. Stored in the HQ project's asset
// library under `uploads/chat/`; the returned asset id is later sent with a
// message via `attachment_ids`. Global route (no `:projectId`) gated on HQ.
chatRoutes.post(
	'/chat/assets',
	bodyLimit({
		maxSize: ATTACHMENT_MAX_BYTES,
		onError: (c) => err(c, 'TOO_LARGE', 'Attachment exceeds 10 MB', 400),
	}),
	async (c) => {
		const access = await authorize(c);
		if (access instanceof Response) return access;

		const db = c.get('db');
		const hqProjectId = await resolveHqProjectId(db);
		if (!hqProjectId) return err(c, 'UNAVAILABLE', 'HQ project not found', 503);

		const upload = await readUploadForm(c);
		if (!upload) return err(c, 'INVALID_REQUEST', 'Missing file field', 400);

		return storeUploadedAsset(
			c,
			DEFAULT_TEAM_ID,
			hqProjectId,
			upload.file,
			null,
			CHAT_UPLOADS_FOLDER,
		);
	},
);

chatRoutes.post('/chat/messages', async (c) => {
	const access = await authorize(c);
	if (access instanceof Response) return access;

	const manager = c.get('chatSessionManager');
	if (!manager) return err(c, 'UNAVAILABLE', 'CEO chat is not available', 503);

	const body = await c.req.json().catch(() => ({}));
	// Either one message (`text` + `attachment_ids`) or an ordered batch
	// (`messages`) — the chatbox flushes its queue as a batch so several messages
	// post as their own bubbles and a single reply answers all of them.
	const batch = parseMessageBatch(body);
	if (!batch) {
		return err(c, 'BAD_REQUEST', 'Message text or an attachment is required', 400);
	}
	if (batch.length > MAX_BATCH_MESSAGES) {
		return err(c, 'BAD_REQUEST', `At most ${MAX_BATCH_MESSAGES} messages per turn`, 400);
	}
	const allAttachmentIds = batch.flatMap((m) => m.attachmentIds);

	// Every attachment must be an HQ-project asset (i.e. uploaded via /chat/assets).
	if (allAttachmentIds.length > 0) {
		const db = c.get('db');
		const hqProjectId = await resolveHqProjectId(db);
		if (!hqProjectId) return err(c, 'UNAVAILABLE', 'HQ project not found', 503);
		const matched = await db.query<{ id: string }>(
			`SELECT DISTINCT id FROM assets WHERE id = ANY($1::uuid[]) AND project_id = $2`,
			[allAttachmentIds, hqProjectId],
		);
		if (matched.rows.length !== new Set(allAttachmentIds).size) {
			return err(c, 'BAD_REQUEST', 'One or more attachments are invalid', 400);
		}
	}

	const auth = c.get('auth');
	const authorUserId = auth.type === AuthType.Admin ? auth.userId : null;
	// An explicit thread from the switcher; omit for the default web thread.
	const conversationId =
		typeof body.conversation_id === 'string' ? body.conversation_id : undefined;

	// Coworker (team-channel) threads are read-only in the web view: a
	// web-composed message would be invisible to the people in the channel, and
	// the CEO's ephemeral platform context wouldn't exist for it. The channel is
	// the write surface.
	if (conversationId) {
		const convo = await manager.getConversation(conversationId);
		// Project DMs are not sendable from the global surface - see
		// resolveConversationId.
		if (convo && convo.team_id !== DEFAULT_TEAM_ID) {
			return err(c, 'NOT_FOUND', 'conversation not found', 404);
		}
		if (convo?.kind === ChatConversationKind.Coworker) {
			return err(
				c,
				'READ_ONLY',
				'This conversation lives in its team channel — reply by mentioning Hezo there',
				409,
			);
		}
		// Closed threads reject sends explicitly (409, not the generic 503 the
		// manager would throw): a converted thread names the task that continues it.
		if (convo?.closed_at) {
			return err(
				c,
				'CLOSED',
				convo.converted_task
					? `This conversation was converted to task ${convo.converted_task.identifier} — follow up there`
					: 'This conversation is closed',
				409,
			);
		}
	}

	try {
		const result = await manager.sendTurn({
			text: batch[0].text,
			channel: ChatChannel.Web,
			conversationId,
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
		return err(c, 'CEO_UNAVAILABLE', (e as Error).message, 503);
	}
});

/** Hard cap on a single turn's queued-message batch. */
export const MAX_BATCH_MESSAGES = 20;

/**
 * Normalize a send body into an ordered batch of user messages. Accepts the
 * single-message shape (`text` / `attachment_ids`) or the batch shape
 * (`messages: [{ text, attachment_ids }]`). Returns null when nothing sendable
 * is present — every message needs text or at least one attachment.
 */
export function parseMessageBatch(
	body: Record<string, unknown>,
): Array<{ text: string; attachmentIds: string[] }> | null {
	const ids = (raw: unknown): string[] =>
		Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : [];
	const raw = Array.isArray(body.messages)
		? body.messages
		: [{ text: body.text, attachment_ids: body.attachment_ids }];
	const batch: Array<{ text: string; attachmentIds: string[] }> = [];
	for (const entry of raw) {
		if (typeof entry !== 'object' || entry === null) return null;
		const m = entry as Record<string, unknown>;
		const text = typeof m.text === 'string' ? m.text.trim() : '';
		const attachmentIds = ids(m.attachment_ids);
		if (!text && attachmentIds.length === 0) return null;
		batch.push({ text, attachmentIds });
	}
	return batch.length > 0 ? batch : null;
}

// List conversation threads (open by default), newest activity first — drives the
// web thread switcher.
chatRoutes.get('/chat/conversations', async (c) => {
	const access = await authorize(c);
	if (access instanceof Response) return access;
	const manager = c.get('chatSessionManager');
	if (!manager) return err(c, 'UNAVAILABLE', 'CEO chat is not available', 503);
	const includeClosed = c.req.query('include_closed') === 'true';
	return ok(c, { conversations: await manager.listConversations({ includeClosed }) });
});

// Create a new web conversation thread (the new-thread button).
chatRoutes.post('/chat/conversations', async (c) => {
	const access = await authorize(c);
	if (access instanceof Response) return access;
	const manager = c.get('chatSessionManager');
	if (!manager) return err(c, 'UNAVAILABLE', 'CEO chat is not available', 503);
	const body = await c.req.json().catch(() => ({}));
	const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : undefined;
	const id = await manager.createWebConversation(title);
	const conversation = await manager.getConversation(id);
	return ok(c, { conversation }, 201);
});

// Convert a conversation into a task in a chosen project, assigned to the CEO:
// the transcript becomes the task description, a system meta message linking
// the task ends the thread, and the conversation closes but stays listed
// (read-only) in the chatbox. Deliberately has NO MCP twin (the precedent is
// documented in routes/connectors.ts): converting the operator's own chat is a
// human-only surface — agents create tasks via the create_task tool.
chatRoutes.post('/chat/conversations/:id/convert-to-task', async (c) => {
	const access = await authorize(c);
	if (access instanceof Response) return access;
	const manager = c.get('chatSessionManager');
	if (!manager) return err(c, 'UNAVAILABLE', 'CEO chat is not available', 503);

	const body = await c.req.json().catch(() => ({}));
	const projectRef = typeof body.project_id === 'string' ? body.project_id.trim() : '';
	if (!projectRef) return err(c, 'BAD_REQUEST', 'project_id is required', 400);
	const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : undefined;

	const db = c.get('db');
	// The whole-thread convert is a CEO-surface affordance; a project DM never
	// reaches it (and has no convert of its own in this phase).
	const source = await manager.getConversation(c.req.param('id'));
	if (!source || source.team_id !== DEFAULT_TEAM_ID) {
		return err(c, 'NOT_FOUND', 'conversation not found', 404);
	}
	const project = await resolveProject(db, projectRef);
	if (!project) return err(c, 'NOT_FOUND', 'project not found', 404);

	// HQ access authorized the chat surface; the task lands in the TARGET
	// project's team, so the caller needs access there too - without this, any
	// HQ member could file tasks into teams they don't belong to.
	const targetAccess = await requireTeamAccessForResource(db, c, project.teamId);
	if (targetAccess instanceof Response) return targetAccess;

	const auth = c.get('auth');
	const caller = {
		actorType: actorTypeFromAuth(auth),
		actorMemberId: await resolveActorMemberId(db, auth, project.teamId),
		actorApiKeyId: apiKeyIdFromAuth(auth),
	};

	try {
		const { conversation } = await manager.convertConversationToTask({
			conversationId: c.req.param('id'),
			projectId: project.projectId,
			projectTeamId: project.teamId,
			title,
			caller,
			events: c.get('events'),
		});
		// The joined reference carries the project slug the task link needs — the
		// same shape the thread listing serves.
		return ok(c, { task: conversation.converted_task, conversation }, 201);
	} catch (e) {
		if (e instanceof ChatConvertError) {
			const status = e.code === 'NOT_FOUND' ? 404 : e.code === 'INVALID_REQUEST' ? 400 : 409;
			return err(c, e.code, e.message, status);
		}
		if (e instanceof CreateTaskError) {
			const status = e.code === 'NOT_FOUND' ? 404 : e.code === 'FORBIDDEN' ? 403 : 400;
			return err(c, e.code, e.message, status);
		}
		throw e;
	}
});

// Close a conversation thread.
chatRoutes.post('/chat/conversations/:id/close', async (c) => {
	const access = await authorize(c);
	if (access instanceof Response) return access;
	const manager = c.get('chatSessionManager');
	if (!manager) return err(c, 'UNAVAILABLE', 'CEO chat is not available', 503);
	const id = c.req.param('id');
	const convo = await manager.getConversation(id);
	if (!convo || convo.team_id !== DEFAULT_TEAM_ID) {
		return err(c, 'NOT_FOUND', 'conversation not found', 404);
	}
	await manager.closeConversation(id);
	return ok(c, { closed: true });
});

// Mark a conversation read up to a message: the server-side unread watermark,
// per (user, conversation), multi-device correct. Global rather than
// per-project because it spans both surfaces; it authorizes against the
// conversation's own team, and writes only on real change so a repeated mark
// costs no row. Admin (human) callers only - agents have no unread.
chatRoutes.post('/chat/conversations/:id/read', async (c) => {
	const auth = c.get('auth');
	if (auth.type !== AuthType.Admin || !auth.userId) {
		return err(c, 'FORBIDDEN', 'reads are per-user', 403);
	}
	const db = c.get('db');
	const id = c.req.param('id');
	const convo = await db.query<{ team_id: string }>(
		`SELECT team_id FROM chat_conversations WHERE id = $1`,
		[id],
	);
	if (!convo.rows[0]) return err(c, 'NOT_FOUND', 'conversation not found', 404);
	const access = await requireTeamAccessForResource(db, c, convo.rows[0].team_id);
	if (access instanceof Response) return access;

	const body = await c.req.json().catch(() => ({}));
	const lastRead = typeof body.last_read_message_id === 'string' ? body.last_read_message_id : null;
	if (!lastRead) return err(c, 'BAD_REQUEST', 'last_read_message_id is required', 400);
	// The watermark must name a message of this conversation, or a crafted id
	// could park the pointer on another thread's message.
	const message = await db.query<{ id: string }>(
		`SELECT id FROM chat_messages WHERE id = $1 AND conversation_id = $2`,
		[lastRead, id],
	);
	if (!message.rows[0]) return err(c, 'BAD_REQUEST', 'message not in this conversation', 400);
	await db.query(
		`INSERT INTO chat_conversation_reads (user_id, conversation_id, last_read_message_id)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (user_id, conversation_id) DO UPDATE
		    SET last_read_message_id = EXCLUDED.last_read_message_id, updated_at = now()
		  WHERE chat_conversation_reads.last_read_message_id IS DISTINCT FROM EXCLUDED.last_read_message_id`,
		[auth.userId, id, lastRead],
	);
	return ok(c, { read: true });
});

chatRoutes.post('/chat/session/restart', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	const manager = c.get('chatSessionManager');
	if (!manager) return err(c, 'UNAVAILABLE', 'CEO chat is not available', 503);
	await manager.restart();
	return ok(c, { restarted: true });
});

function clampLimit(raw: string | undefined): number {
	const n = raw ? Number.parseInt(raw, 10) : 100;
	if (!Number.isFinite(n) || n <= 0) return 100;
	return Math.min(n, 200);
}
