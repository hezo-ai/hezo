import {
	ATTACHMENT_MAX_BYTES,
	AuthType,
	CHAT_UPLOADS_FOLDER,
	ChatChannel,
	DEFAULT_TEAM_ID,
} from '@hezo/shared';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Db } from '../db/database';
import { loadChatMessageAttachments } from '../lib/chat-attachments';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { requireAdminEquivalent, requireTeamAccessForResource } from '../middleware/auth';
import { readUploadForm, storeUploadedAsset } from './assets';

export const chatRoutes = new Hono<Env>();

const MESSAGE_COLUMNS = `id, conversation_id, role, channel, status, content, author_user_id,
	input_tokens, output_tokens, cost_cents, error, created_at, completed_at`;

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
	const conversationId = await manager.getConversationId();

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
	const conversationId = await manager.getConversationId();

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
	const text = typeof body.text === 'string' ? body.text.trim() : '';
	const attachmentIds: string[] = Array.isArray(body.attachment_ids)
		? body.attachment_ids.filter((id: unknown): id is string => typeof id === 'string')
		: [];
	// A message needs either text or at least one attachment.
	if (!text && attachmentIds.length === 0) {
		return err(c, 'BAD_REQUEST', 'Message text or an attachment is required', 400);
	}

	// Every attachment must be an HQ-project asset (i.e. uploaded via /chat/assets).
	if (attachmentIds.length > 0) {
		const db = c.get('db');
		const hqProjectId = await resolveHqProjectId(db);
		if (!hqProjectId) return err(c, 'UNAVAILABLE', 'HQ project not found', 503);
		const matched = await db.query<{ id: string }>(
			`SELECT id FROM assets WHERE id = ANY($1::uuid[]) AND project_id = $2`,
			[attachmentIds, hqProjectId],
		);
		if (matched.rows.length !== attachmentIds.length) {
			return err(c, 'BAD_REQUEST', 'One or more attachments are invalid', 400);
		}
	}

	const auth = c.get('auth');
	const authorUserId = auth.type === AuthType.Admin ? auth.userId : null;

	try {
		const result = await manager.sendTurn({
			text,
			channel: ChatChannel.Web,
			authorUserId,
			attachmentIds,
		});
		return ok(
			c,
			{ user_message_id: result.userMessageId, assistant_message_id: result.assistantMessageId },
			201,
		);
	} catch (e) {
		return err(c, 'CEO_UNAVAILABLE', (e as Error).message, 503);
	}
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
