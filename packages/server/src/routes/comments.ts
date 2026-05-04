import { AuthType, CommentContentType, GrantScope, WakeupSource, wsRoom } from '@hezo/shared';
import { Hono } from 'hono';
import { encrypt } from '../crypto/encryption';
import { broadcastChange } from '../lib/broadcast';
import { validateCredentialValue } from '../lib/credential-validator';
import { resolveIssueId } from '../lib/resolve';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { requireCompanyAccess } from '../middleware/auth';
import { fireCommentWakeups } from '../services/comment-wakeups';
import { parseEffortFromCommentBody } from '../services/effort';
import { recordIssueLinks } from '../services/issue-events';
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
		authorRunId: auth.type === AuthType.Agent ? auth.runId : null,
		effort: commentEffort,
		wakeAssignee,
	});

	const commentText = typeof body.content?.text === 'string' ? body.content.text : '';
	if (commentText) {
		recordIssueLinks(db, companyId, issueId, commentText, authorMemberId, c.get('wsManager')).catch(
			(e) => log.error('Failed to record issue links from comment:', e),
		);
	}

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

commentsRoutes.post(
	'/companies/:companyId/issues/:issueId/comments/:commentId/fulfill-credential',
	async (c) => {
		const access = await requireCompanyAccess(c);
		if (access instanceof Response) return access;

		const db = c.get('db');
		const masterKeyManager = c.get('masterKeyManager');
		const { companyId } = access;
		const issueId = await resolveIssueId(db, companyId, c.req.param('issueId'));
		if (!issueId) return err(c, 'NOT_FOUND', 'Issue not found', 404);
		const commentId = c.req.param('commentId');

		const body = await c.req.json<{ value?: string; confirmed?: boolean }>();

		const existing = await db.query<{
			content_type: string;
			issue_id: string;
			content: Record<string, unknown>;
			chosen_option: Record<string, unknown> | null;
			author_member_id: string | null;
		}>(
			'SELECT content_type, issue_id, content, chosen_option, author_member_id FROM issue_comments WHERE id = $1 AND issue_id = $2',
			[commentId, issueId],
		);
		if (existing.rows.length === 0) return err(c, 'NOT_FOUND', 'Comment not found', 404);
		const row = existing.rows[0];
		if (row.content_type !== CommentContentType.CredentialRequest) {
			return err(c, 'INVALID_REQUEST', 'Comment is not a credential request', 400);
		}
		if (row.chosen_option !== null) {
			return err(c, 'INVALID_REQUEST', 'Credential request already fulfilled', 400);
		}

		const requestContent = row.content;
		const name = String(requestContent.name ?? '');
		const kind = String(requestContent.kind ?? '');
		const scope = String(requestContent.scope ?? 'company');
		const projectId =
			scope === 'project' && typeof requestContent.project_id === 'string'
				? requestContent.project_id
				: null;
		const allowedHosts = Array.isArray(requestContent.allowed_hosts)
			? (requestContent.allowed_hosts as string[])
			: [];
		const requestingAgentId = row.author_member_id;

		const isConfirmation = typeof requestContent.confirmation_text === 'string';
		let storedValue: string | null = null;

		if (isConfirmation) {
			if (body.confirmed !== true) {
				return err(c, 'INVALID_REQUEST', 'confirmed must be true', 400);
			}
			storedValue = '';
		} else {
			const value = body.value;
			if (typeof value !== 'string') {
				return err(c, 'INVALID_REQUEST', 'value is required', 400);
			}
			const validation = validateCredentialValue(kind, value);
			if (!validation.valid) {
				return err(c, 'INVALID_REQUEST', validation.error, 400);
			}
			storedValue = value;
		}

		const encryptionKey = masterKeyManager.getKey();
		if (!encryptionKey) {
			return err(c, 'LOCKED', 'Master key not available', 503);
		}

		await db.query('BEGIN');
		let secretId: string;
		let updatedComment: Record<string, unknown>;
		try {
			const encryptedValue = isConfirmation ? '' : encrypt(storedValue as string, encryptionKey);
			const category = pickSecretCategory(kind);

			const upsert = await db.query<{ id: string }>(
				`INSERT INTO secrets (company_id, project_id, name, encrypted_value, category, allowed_hosts)
				 VALUES ($1, $2, $3, $4, $5::secret_category, $6::text[])
				 ON CONFLICT (company_id, project_id, name)
				 DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value,
				               category = EXCLUDED.category,
				               allowed_hosts = EXCLUDED.allowed_hosts,
				               updated_at = now()
				 RETURNING id`,
				[companyId, projectId, name, encryptedValue, category, allowedHosts],
			);
			secretId = upsert.rows[0].id;

			if (requestingAgentId) {
				await db.query(
					`INSERT INTO secret_grants (secret_id, member_id, scope)
					 VALUES ($1, $2, $3::grant_scope)
					 ON CONFLICT (secret_id, member_id) DO NOTHING`,
					[secretId, requestingAgentId, GrantScope.Single],
				);
			}

			const updated = await db.query(
				`UPDATE issue_comments
				   SET chosen_option = $1::jsonb
				 WHERE id = $2
				 RETURNING *`,
				[
					JSON.stringify({ secret_id: secretId, fulfilled_at: new Date().toISOString() }),
					commentId,
				],
			);
			updatedComment = updated.rows[0] as Record<string, unknown>;

			await db.query(
				`INSERT INTO issue_comments (issue_id, content_type, content)
				 VALUES ($1, 'system'::comment_content_type, $2::jsonb)`,
				[
					issueId,
					JSON.stringify({
						text: isConfirmation
							? `Confirmed: ${name}`
							: `Credential provided: ${name} (stored as secret, value not shown)`,
					}),
				],
			);
			await db.query('COMMIT');
		} catch (e) {
			await db.query('ROLLBACK');
			throw e;
		}

		if (requestingAgentId) {
			const isAgent = await db.query('SELECT id FROM member_agents WHERE id = $1', [
				requestingAgentId,
			]);
			if (isAgent.rows.length > 0) {
				try {
					await createWakeup(db, requestingAgentId, companyId, WakeupSource.CredentialProvided, {
						issue_id: issueId,
						comment_id: commentId,
						secret_id: secretId,
						name,
					});
				} catch (e) {
					log.error('Failed to create credential_provided wakeup:', e);
				}
			}
		}

		broadcastChange(c, wsRoom.company(companyId), 'issue_comments', 'UPDATE', updatedComment);
		return ok(c, { secret_id: secretId, comment_id: commentId });
	},
);

function pickSecretCategory(kind: string): string {
	switch (kind) {
		case 'ssh_private_key':
			return 'ssh_key';
		case 'github_pat':
		case 'oauth_token':
			return 'api_token';
		case 'api_key':
		case 'webhook_secret':
			return 'credential';
		default:
			return 'other';
	}
}
