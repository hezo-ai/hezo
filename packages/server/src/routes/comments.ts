import { AuthType, CommentContentType, WakeupSource, wsRoom } from '@hezo/shared';
import { Hono } from 'hono';
import { broadcastChange } from '../lib/broadcast';
import { resolveIssueId } from '../lib/resolve';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { requireCompanyAccess } from '../middleware/auth';
import { fireCommentWakeups } from '../services/comment-wakeups';
import { parseEffortFromCommentBody } from '../services/effort';
import { createWakeup } from '../services/wakeup';

const log = logger.child('routes');

export const commentsRoutes = new Hono<Env>();

commentsRoutes.get('/companies/:companyId/issues/:issueId/comments', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const issueId = await resolveIssueId(db, companyId, c.req.param('issueId'));
	if (!issueId) return err(c, 'NOT_FOUND', 'Issue not found', 404);
	const includeToolCalls = c.req.query('include_tool_calls') === 'true';

	const result = await db.query(
		`SELECT ic.id, ic.issue_id, ic.content_type, ic.content, ic.chosen_option, ic.created_at,
            m.member_type AS author_type,
            COALESCE(ma.title, m.display_name, 'Board') AS author_name,
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
			if (comment.content_type === CommentContentType.Trace) {
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
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const issueId = await resolveIssueId(db, companyId, c.req.param('issueId'));
	if (!issueId) return err(c, 'NOT_FOUND', 'Issue not found', 404);
	const auth = c.get('auth');

	const issueCheck = await db.query<{ id: string; assignee_id: string | null }>(
		'SELECT id, assignee_id FROM issues WHERE id = $1 AND company_id = $2',
		[issueId, companyId],
	);
	if (issueCheck.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Issue not found', 404);
	}

	const body = await c.req.json<{
		content_type?: string;
		content: Record<string, unknown>;
		effort?: string;
		wake_assignee?: boolean;
	}>();

	if (!body.content) {
		return err(c, 'INVALID_REQUEST', 'content is required', 400);
	}

	// Optional per-comment effort override. Board users set this to dial up/down
	// the reasoning budget of the agent run that the comment triggers.
	const commentEffort = parseEffortFromCommentBody(body);

	let authorMemberId: string | null = null;
	if (auth.type === AuthType.Board) {
		authorMemberId = null;
	} else if (auth.type === AuthType.Agent) {
		authorMemberId = auth.memberId;
	}

	// Only Board (human) callers can opt into waking the assignee on a plain
	// comment. Agent-authored paths (/agent-api, /mcp) keep mention-only behavior
	// regardless of the body field.
	const wakeAssignee = auth.type === AuthType.Board && body.wake_assignee === true;

	const result = await db.query<{ id: string }>(
		`INSERT INTO issue_comments (issue_id, author_member_id, content_type, content)
     VALUES ($1, $2, $3::comment_content_type, $4::jsonb)
     RETURNING *`,
		[
			issueId,
			authorMemberId,
			body.content_type ?? CommentContentType.Text,
			JSON.stringify(body.content),
		],
	);

	await fireCommentWakeups({
		db,
		issueId,
		companyId,
		commentId: result.rows[0].id,
		content: body.content,
		contentType: body.content_type ?? CommentContentType.Text,
		authorMemberId,
		effort: commentEffort,
		wakeAssignee,
	});

	broadcastChange(
		c,
		wsRoom.company(companyId),
		'issue_comments',
		'INSERT',
		result.rows[0] as Record<string, unknown>,
	);
	return ok(c, result.rows[0], 201);
});

commentsRoutes.post(
	'/companies/:companyId/issues/:issueId/comments/:commentId/choose',
	async (c) => {
		const access = await requireCompanyAccess(c);
		if (access instanceof Response) return access;

		const db = c.get('db');
		const { companyId } = access;
		const issueId = await resolveIssueId(db, companyId, c.req.param('issueId'));
		if (!issueId) return err(c, 'NOT_FOUND', 'Issue not found', 404);
		const commentId = c.req.param('commentId');

		const body = await c.req.json<{ chosen_id: string }>();
		if (!body.chosen_id) {
			return err(c, 'INVALID_REQUEST', 'chosen_id is required', 400);
		}

		// Verify comment belongs to the issue
		const existing = await db.query<{ content_type: string; issue_id: string }>(
			'SELECT content_type, issue_id FROM issue_comments WHERE id = $1 AND issue_id = $2',
			[commentId, issueId],
		);
		if (existing.rows.length === 0) {
			return err(c, 'NOT_FOUND', 'Comment not found', 404);
		}
		if (existing.rows[0].content_type !== CommentContentType.Options) {
			return err(c, 'INVALID_REQUEST', 'Can only choose on options-type comments', 400);
		}

		await db.query('BEGIN');
		let result: Awaited<ReturnType<typeof db.query>>;
		try {
			result = await db.query(
				'UPDATE issue_comments SET chosen_option = $1::jsonb WHERE id = $2 RETURNING *',
				[JSON.stringify({ chosen_id: body.chosen_id }), commentId],
			);

			await db.query(
				`INSERT INTO issue_comments (issue_id, content_type, content)
         VALUES ($1, $2::comment_content_type, $3::jsonb)`,
				[
					existing.rows[0].issue_id,
					CommentContentType.System,
					JSON.stringify({ text: `Board selected option: ${body.chosen_id}` }),
				],
			);
			await db.query('COMMIT');
		} catch (e) {
			await db.query('ROLLBACK');
			throw e;
		}

		const issue = await db.query<{ assignee_id: string | null }>(
			'SELECT assignee_id FROM issues WHERE id = $1',
			[existing.rows[0].issue_id],
		);
		const assigneeId = issue.rows[0]?.assignee_id;
		if (assigneeId) {
			const isAgent = await db.query('SELECT id FROM member_agents WHERE id = $1', [assigneeId]);
			if (isAgent.rows.length > 0) {
				createWakeup(db, assigneeId, companyId, WakeupSource.OptionChosen, {
					issue_id: existing.rows[0].issue_id,
					chosen_id: body.chosen_id,
				}).catch((e) => log.error('Failed to create option_chosen wakeup:', e));
			}
		}

		broadcastChange(
			c,
			wsRoom.company(companyId),
			'issue_comments',
			'UPDATE',
			result.rows[0] as Record<string, unknown>,
		);
		return ok(c, result.rows[0]);
	},
);
