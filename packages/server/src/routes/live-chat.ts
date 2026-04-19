import { AuthType, WakeupSource, wsRoom } from '@hezo/shared';
import { Hono } from 'hono';
import { broadcastEvent } from '../lib/broadcast';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { requireCompanyAccess } from '../middleware/auth';
import { createWakeup } from '../services/wakeup';

const log = logger.child('routes');

export const liveChatRoutes = new Hono<Env>();

liveChatRoutes.get('/companies/:companyId/issues/:issueId/chat/messages', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const issueId = c.req.param('issueId');

	const issueCheck = await db.query('SELECT id FROM issues WHERE id = $1 AND company_id = $2', [
		issueId,
		companyId,
	]);
	if (issueCheck.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Issue not found', 404);
	}

	const chat = await db.query<{ id: string }>('SELECT id FROM live_chats WHERE issue_id = $1', [
		issueId,
	]);

	if (chat.rows.length === 0) {
		return ok(c, []);
	}

	const result = await db.query(
		`SELECT m.id, m.chat_id, m.author_member_id, m.author_type, m.content,
		        m.metadata, m.created_at,
		        COALESCE(ma.title, mem.display_name) AS author_name
		 FROM live_chat_messages m
		 LEFT JOIN members mem ON mem.id = m.author_member_id
		 LEFT JOIN member_agents ma ON ma.id = m.author_member_id
		 WHERE m.chat_id = $1
		 ORDER BY m.created_at ASC`,
		[chat.rows[0].id],
	);

	return ok(c, result.rows);
});

liveChatRoutes.post('/companies/:companyId/issues/:issueId/chat/messages', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const issueId = c.req.param('issueId');
	const auth = c.get('auth');

	const issueCheck = await db.query('SELECT id FROM issues WHERE id = $1 AND company_id = $2', [
		issueId,
		companyId,
	]);
	if (issueCheck.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Issue not found', 404);
	}

	const body = await c.req.json<{ content: string }>();
	if (!body.content?.trim()) {
		return err(c, 'INVALID_REQUEST', 'content is required', 400);
	}

	const authorMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
	const authorType = auth.type === AuthType.Agent ? AuthType.Agent : AuthType.Board;

	const chatResult = await db.query<{ id: string }>(
		`INSERT INTO live_chats (issue_id)
		 VALUES ($1)
		 ON CONFLICT (issue_id) DO UPDATE SET updated_at = now()
		 RETURNING id`,
		[issueId],
	);
	const chatId = chatResult.rows[0].id;

	const result = await db.query(
		`INSERT INTO live_chat_messages (chat_id, author_member_id, author_type, content)
		 VALUES ($1, $2, $3, $4)
		 RETURNING *`,
		[chatId, authorMemberId, authorType, body.content.trim()],
	);

	const message = result.rows[0] as Record<string, unknown>;

	const wsManager = c.get('wsManager');
	broadcastEvent(wsManager, wsRoom.company(companyId), 'chat_message', {
		issueId,
		message,
	});

	const mentions = body.content.match(/@([\w-]+)/g);
	if (mentions) {
		for (const mention of mentions) {
			const slug = mention.slice(1);
			const mentioned = await db.query<{ id: string }>(
				`SELECT ma.id FROM member_agents ma
				 JOIN members m ON m.id = ma.id
				 WHERE ma.slug = $1 AND m.company_id = $2`,
				[slug, companyId],
			);
			if (mentioned.rows.length > 0) {
				createWakeup(db, mentioned.rows[0].id, companyId, WakeupSource.ChatMessage, {
					issue_id: issueId,
					chat_message_id: message.id,
				}).catch((e) => log.error('Failed to create chat_message wakeup:', e));
			}
		}
	}

	return ok(c, message, 201);
});
