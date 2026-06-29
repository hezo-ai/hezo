import { AuthType, CeoChannel, DEFAULT_TEAM_ID } from '@hezo/shared';
import { type Context, Hono } from 'hono';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { requireAdminEquivalent, requireTeamAccessForResource } from '../middleware/auth';

export const ceoChatRoutes = new Hono<Env>();

const MESSAGE_COLUMNS = `id, conversation_id, role, channel, status, content, author_user_id,
	input_tokens, output_tokens, cost_cents, error, created_at, completed_at`;

/**
 * The CEO chat is instance-wide (one global conversation), so these are global
 * endpoints gated on access to the HQ team rather than a `:teamId` route param.
 */
function authorize(c: Context<Env>): Promise<{ teamId: string } | Response> {
	return requireTeamAccessForResource(c.get('db'), c, DEFAULT_TEAM_ID);
}

ceoChatRoutes.get('/ceo/conversation', async (c) => {
	const access = await authorize(c);
	if (access instanceof Response) return access;

	const manager = c.get('ceoSessionManager');
	if (!manager) return err(c, 'UNAVAILABLE', 'CEO chat is not available', 503);
	const conversationId = await manager.getConversationId();

	// The chatbox shows the active window — the non-compacted messages. Older
	// messages have been summarized into long-term memory and dropped. The window
	// is bounded by compaction, so the full active set is returned (no limit).
	const messages = await c.get('db').query(
		`SELECT ${MESSAGE_COLUMNS} FROM ceo_messages
			 WHERE conversation_id = $1 AND compacted_at IS NULL
			 ORDER BY created_at ASC`,
		[conversationId],
	);
	return ok(c, { conversation_id: conversationId, messages: messages.rows });
});

ceoChatRoutes.get('/ceo/messages', async (c) => {
	const access = await authorize(c);
	if (access instanceof Response) return access;

	const manager = c.get('ceoSessionManager');
	if (!manager) return err(c, 'UNAVAILABLE', 'CEO chat is not available', 503);
	const conversationId = await manager.getConversationId();

	const limit = clampLimit(c.req.query('limit'));
	const before = c.req.query('before');
	const rows = before
		? await c.get('db').query(
				`SELECT ${MESSAGE_COLUMNS} FROM ceo_messages
				 WHERE conversation_id = $1 AND compacted_at IS NULL AND created_at < $2
				 ORDER BY created_at DESC LIMIT $3`,
				[conversationId, before, limit],
			)
		: await c.get('db').query(
				`SELECT ${MESSAGE_COLUMNS} FROM ceo_messages
				 WHERE conversation_id = $1 AND compacted_at IS NULL
				 ORDER BY created_at DESC LIMIT $2`,
				[conversationId, limit],
			);
	return ok(c, { messages: rows.rows.reverse() });
});

ceoChatRoutes.post('/ceo/messages', async (c) => {
	const access = await authorize(c);
	if (access instanceof Response) return access;

	const manager = c.get('ceoSessionManager');
	if (!manager) return err(c, 'UNAVAILABLE', 'CEO chat is not available', 503);

	const body = await c.req.json().catch(() => ({}));
	const text = typeof body.text === 'string' ? body.text.trim() : '';
	if (!text) return err(c, 'BAD_REQUEST', 'Message text is required', 400);

	const auth = c.get('auth');
	const authorUserId = auth.type === AuthType.Admin ? auth.userId : null;

	try {
		const result = await manager.sendTurn({ text, channel: CeoChannel.Web, authorUserId });
		return ok(
			c,
			{ user_message_id: result.userMessageId, assistant_message_id: result.assistantMessageId },
			201,
		);
	} catch (e) {
		return err(c, 'CEO_UNAVAILABLE', (e as Error).message, 503);
	}
});

ceoChatRoutes.post('/ceo/session/restart', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	const manager = c.get('ceoSessionManager');
	if (!manager) return err(c, 'UNAVAILABLE', 'CEO chat is not available', 503);
	await manager.restart();
	return ok(c, { restarted: true });
});

function clampLimit(raw: string | undefined): number {
	const n = raw ? Number.parseInt(raw, 10) : 100;
	if (!Number.isFinite(n) || n <= 0) return 100;
	return Math.min(n, 200);
}
