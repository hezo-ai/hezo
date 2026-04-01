import { Hono } from 'hono';
import { broadcastChange } from '../lib/broadcast';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { createWakeup } from '../services/wakeup';

export const commentsRoutes = new Hono<Env>();

commentsRoutes.get('/companies/:companyId/issues/:issueId/comments', async (c) => {
	const db = c.get('db');
	const issueId = c.req.param('issueId');
	const includeToolCalls = c.req.query('include_tool_calls') === 'true';

	const result = await db.query(
		`SELECT ic.id, ic.issue_id, ic.content_type, ic.content, ic.chosen_option, ic.created_at,
            m.member_type AS author_type,
            COALESCE(ma.title, m.display_name) AS author_name,
            ic.author_member_id
     FROM issue_comments ic
     LEFT JOIN members m ON m.id = ic.author_member_id
     LEFT JOIN member_agents ma ON ma.id = ic.author_member_id
     WHERE ic.issue_id = $1
     ORDER BY ic.created_at ASC`,
		[issueId],
	);

	if (includeToolCalls) {
		for (const comment of result.rows as Record<string, unknown>[]) {
			if (comment.content_type === 'trace') {
				const toolCalls = await db.query(
					'SELECT * FROM tool_calls WHERE comment_id = $1 ORDER BY created_at ASC',
					[comment.id],
				);
				comment.tool_calls = toolCalls.rows;
			} else {
				comment.tool_calls = [];
			}
		}
	}

	return ok(c, result.rows);
});

commentsRoutes.post('/companies/:companyId/issues/:issueId/comments', async (c) => {
	const db = c.get('db');
	const issueId = c.req.param('issueId');
	const auth = c.get('auth');

	const body = await c.req.json<{
		content_type?: string;
		content: Record<string, unknown>;
	}>();

	if (!body.content) {
		return err(c, 'INVALID_REQUEST', 'content is required', 400);
	}

	// Find the board member for this company (if board auth)
	let authorMemberId: string | null = null;
	if (auth.type === 'board') {
		// For board users, author_member_id is null (board post)
		authorMemberId = null;
	} else if (auth.type === 'agent') {
		authorMemberId = auth.memberId;
	}

	const result = await db.query<{ id: string }>(
		`INSERT INTO issue_comments (issue_id, author_member_id, content_type, content)
     VALUES ($1, $2, $3::comment_content_type, $4::jsonb)
     RETURNING *`,
		[issueId, authorMemberId, body.content_type ?? 'text', JSON.stringify(body.content)],
	);

	const companyId = c.req.param('companyId');
	const contentText = typeof body.content === 'object' ? JSON.stringify(body.content) : '';
	const mentions = contentText.match(/@([\w-]+)/g);
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
				createWakeup(db, mentioned.rows[0].id, companyId, 'mention', {
					issue_id: issueId,
					comment_id: result.rows[0].id,
				}).catch((e) => console.error('Failed to create mention wakeup:', e));
			}
		}
	}

	broadcastChange(
		c,
		`company:${companyId}`,
		'issue_comments',
		'INSERT',
		result.rows[0] as Record<string, unknown>,
	);
	return ok(c, result.rows[0], 201);
});

commentsRoutes.post(
	'/companies/:companyId/issues/:issueId/comments/:commentId/choose',
	async (c) => {
		const db = c.get('db');
		const commentId = c.req.param('commentId');

		const body = await c.req.json<{ chosen_id: string }>();
		if (!body.chosen_id) {
			return err(c, 'INVALID_REQUEST', 'chosen_id is required', 400);
		}

		// Verify it's an options-type comment
		const existing = await db.query<{ content_type: string; issue_id: string }>(
			'SELECT content_type, issue_id FROM issue_comments WHERE id = $1',
			[commentId],
		);
		if (existing.rows.length === 0) {
			return err(c, 'NOT_FOUND', 'Comment not found', 404);
		}
		if (existing.rows[0].content_type !== 'options') {
			return err(c, 'INVALID_REQUEST', 'Can only choose on options-type comments', 400);
		}

		const result = await db.query(
			'UPDATE issue_comments SET chosen_option = $1::jsonb WHERE id = $2 RETURNING *',
			[JSON.stringify({ chosen_id: body.chosen_id }), commentId],
		);

		// Post a system comment recording the choice
		await db.query(
			`INSERT INTO issue_comments (issue_id, content_type, content)
       VALUES ($1, 'system'::comment_content_type, $2::jsonb)`,
			[
				existing.rows[0].issue_id,
				JSON.stringify({ text: `Board selected option: ${body.chosen_id}` }),
			],
		);

		const companyId = c.req.param('companyId');
		const issue = await db.query<{ assignee_id: string | null }>(
			'SELECT assignee_id FROM issues WHERE id = $1',
			[existing.rows[0].issue_id],
		);
		const assigneeId = issue.rows[0]?.assignee_id;
		if (assigneeId) {
			const isAgent = await db.query('SELECT id FROM member_agents WHERE id = $1', [assigneeId]);
			if (isAgent.rows.length > 0) {
				createWakeup(db, assigneeId, companyId, 'option_chosen', {
					issue_id: existing.rows[0].issue_id,
					chosen_id: body.chosen_id,
				}).catch((e) => console.error('Failed to create option_chosen wakeup:', e));
			}
		}

		broadcastChange(
			c,
			`company:${companyId}`,
			'issue_comments',
			'UPDATE',
			result.rows[0] as Record<string, unknown>,
		);
		return ok(c, result.rows[0]);
	},
);
