import {
	AuthType,
	CommentContentType,
	DEFAULT_TEAM_ID,
	GrantScope,
	WakeupSource,
	wsRoom,
} from '@hezo/shared';
import { Hono } from 'hono';
import { encrypt } from '../crypto/encryption';
import { signAssetUrl } from '../lib/asset-urls';
import { trackBackground } from '../lib/background';
import { broadcastChange } from '../lib/broadcast';
import { validateCredentialValue } from '../lib/credential-validator';
import { resolveActor, resolveActorMemberId, resolveTaskId } from '../lib/resolve';
import { err, ok } from '../lib/response';
import { withTransaction } from '../lib/sql';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { fireCommentWakeups } from '../services/comment-wakeups';
import { parseEffortFromCommentBody } from '../services/effort';
import {
	addCommentReaction,
	loadReactionsForTask,
	removeCommentReaction,
} from '../services/reactions';
import { recordTaskLinks } from '../services/task-events';
import { createWakeup } from '../services/wakeup';

const log = logger.child('routes');

export const commentsRoutes = new Hono<Env>();

commentsRoutes.get('/projects/:projectId/tasks/:taskId/comments', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const taskId = await resolveTaskId(db, teamId, c.req.param('taskId'));
	if (!taskId) return err(c, 'NOT_FOUND', 'Task not found', 404);
	const includeToolCalls = c.req.query('include_tool_calls') === 'true';

	const result = await db.query(
		`SELECT ic.id, ic.task_id, ic.content_type, ic.content, ic.chosen_option, ic.created_at,
            m.member_type AS author_type,
            COALESCE(ma.title, m.display_name, 'Admin') AS author_name,
            ma.slug AS author_slug,
            (m.team_id = $2) AS author_is_instance,
            ic.author_member_id,
            ic.parent_comment_id
     FROM task_comments ic
     LEFT JOIN members m ON m.id = ic.author_member_id
     LEFT JOIN member_agents ma ON ma.id = ic.author_member_id
     WHERE ic.task_id = $1
     ORDER BY ic.created_at ASC`,
		[taskId, DEFAULT_TEAM_ID],
	);

	const viewerMemberId = await resolveActorMemberId(db, c.get('auth'), teamId);
	const reactionsByComment = await loadReactionsForTask(db, taskId, viewerMemberId);
	for (const comment of result.rows as Record<string, unknown>[]) {
		comment.reactions = reactionsByComment.get(comment.id as string) ?? [];
	}

	const commentIds = (result.rows as Array<{ id: string }>).map((r) => r.id);
	const attachmentsByComment = await loadAttachmentsForComments(
		db,
		commentIds,
		c.get('masterKeyManager'),
	);
	for (const comment of result.rows as Record<string, unknown>[]) {
		comment.attachments = attachmentsByComment.get(comment.id as string) ?? [];
	}

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

commentsRoutes.put(
	'/projects/:projectId/tasks/:taskId/comments/:commentId/reactions/:kind',
	async (c) => {
		const teamId = c.get('teamId') as string;
		const db = c.get('db');
		const taskId = await resolveTaskId(db, teamId, c.req.param('taskId'));
		if (!taskId) return err(c, 'NOT_FOUND', 'Task not found', 404);
		const commentId = c.req.param('commentId');
		const kind = c.req.param('kind');

		const memberId = await resolveActorMemberId(db, c.get('auth'), teamId);
		if (!memberId) {
			return err(c, 'FORBIDDEN', 'No member identity for caller', 403);
		}

		const result = await addCommentReaction({ db, teamId, taskId, commentId, kind, memberId });
		if (!result.ok) {
			const status = result.code === 'INVALID_KIND' ? 400 : 404;
			return err(c, result.code, result.message, status);
		}

		broadcastChange(c, wsRoom.team(teamId), 'comment_reactions', 'INSERT', {
			comment_id: commentId,
			task_id: taskId,
			member_id: memberId,
			kind,
		});
		return ok(c, { comment_id: commentId, kind, reactions: result.reactions });
	},
);

commentsRoutes.delete(
	'/projects/:projectId/tasks/:taskId/comments/:commentId/reactions/:kind',
	async (c) => {
		const teamId = c.get('teamId') as string;
		const db = c.get('db');
		const taskId = await resolveTaskId(db, teamId, c.req.param('taskId'));
		if (!taskId) return err(c, 'NOT_FOUND', 'Task not found', 404);
		const commentId = c.req.param('commentId');
		const kind = c.req.param('kind');

		const memberId = await resolveActorMemberId(db, c.get('auth'), teamId);
		if (!memberId) {
			return err(c, 'FORBIDDEN', 'No member identity for caller', 403);
		}

		const result = await removeCommentReaction({
			db,
			teamId,
			taskId,
			commentId,
			kind,
			memberId,
		});
		if (!result.ok) {
			const status = result.code === 'INVALID_KIND' ? 400 : 404;
			return err(c, result.code, result.message, status);
		}

		broadcastChange(c, wsRoom.team(teamId), 'comment_reactions', 'DELETE', {
			comment_id: commentId,
			task_id: taskId,
			member_id: memberId,
			kind,
		});
		return ok(c, { comment_id: commentId, kind, reactions: result.reactions });
	},
);

commentsRoutes.post('/projects/:projectId/tasks/:taskId/comments', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const taskId = await resolveTaskId(db, teamId, c.req.param('taskId'));
	if (!taskId) return err(c, 'NOT_FOUND', 'Task not found', 404);
	const auth = c.get('auth');

	const taskCheck = await db.query<{ id: string; assignee_id: string | null }>(
		'SELECT id, assignee_id FROM tasks WHERE id = $1 AND team_id = $2',
		[taskId, teamId],
	);
	if (taskCheck.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Task not found', 404);
	}

	const body = await c.req.json<{
		content_type?: string;
		content: Record<string, unknown>;
		effort?: string;
		wake_assignee?: boolean;
		parent_comment_id?: string | null;
		attachment_ids?: string[];
	}>();

	const attachmentIds = Array.isArray(body.attachment_ids) ? body.attachment_ids : [];
	const contentType = body.content_type ?? CommentContentType.Text;
	const isText = contentType === CommentContentType.Text;
	if (isText) {
		const text =
			typeof body.content === 'string'
				? body.content
				: typeof body.content === 'object' && body.content !== null
					? ((body.content as Record<string, unknown>).text as string | undefined)
					: undefined;
		if ((typeof text !== 'string' || text.length === 0) && attachmentIds.length === 0) {
			return err(c, 'INVALID_REQUEST', 'content or attachment_ids is required', 400);
		}
	} else if (!body.content) {
		return err(c, 'INVALID_REQUEST', 'content is required', 400);
	}
	if (attachmentIds.length > 0) {
		const matched = await db.query<{ id: string }>(
			`SELECT id FROM assets
			 WHERE id = ANY($1::uuid[])
			   AND project_id = (SELECT project_id FROM tasks WHERE id = $2)`,
			[attachmentIds, taskId],
		);
		if (matched.rows.length !== attachmentIds.length) {
			return err(
				c,
				'INVALID_REQUEST',
				'One or more attachments do not belong to this project',
				400,
			);
		}
	}

	// Optional per-comment effort override. Admin users set this to dial up/down
	// the reasoning budget of the agent run that the comment triggers.
	const commentEffort = parseEffortFromCommentBody(body);

	let parentCommentId: string | null = null;
	if (body.parent_comment_id) {
		const parentCheck = await db.query(
			'SELECT 1 FROM task_comments WHERE id = $1 AND task_id = $2',
			[body.parent_comment_id, taskId],
		);
		if (parentCheck.rows.length === 0) {
			return err(c, 'INVALID_REQUEST', 'parent_comment_id does not belong to this task', 400);
		}
		parentCommentId = body.parent_comment_id;
	}

	let authorMemberId: string | null = null;
	if (auth.type === AuthType.Admin) {
		authorMemberId = null;
	} else if (auth.type === AuthType.Agent) {
		authorMemberId = auth.memberId;
	}

	// Only Admin (human) callers can opt into waking the assignee on a plain
	// comment. Agent-authored paths (/agent-api, /mcp) keep mention-only behavior
	// regardless of the body field.
	const wakeAssignee = auth.type === AuthType.Admin && body.wake_assignee === true;

	const result = await withTransaction(db, async () => {
		const inserted = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, parent_comment_id, content_type, content)
     VALUES ($1, $2, $3, $4::comment_content_type, $5::jsonb)
     RETURNING *`,
			[
				taskId,
				authorMemberId,
				parentCommentId,
				body.content_type ?? CommentContentType.Text,
				JSON.stringify(body.content),
			],
		);

		if (attachmentIds.length > 0) {
			const newCommentId = inserted.rows[0].id;
			await db.query(
				`INSERT INTO comment_attachments (comment_id, asset_id)
				 SELECT $1::uuid, asset FROM UNNEST($2::uuid[]) AS asset`,
				[newCommentId, attachmentIds],
			);
		}
		return inserted;
	});

	await fireCommentWakeups({
		db,
		taskId,
		teamId,
		commentId: result.rows[0].id,
		content: body.content,
		contentType: body.content_type ?? CommentContentType.Text,
		authorMemberId,
		authorUserId: auth.type === AuthType.Admin ? auth.userId : null,
		authorRunId: auth.type === AuthType.Agent ? auth.runId : null,
		effort: commentEffort,
		wakeAssignee,
		parentCommentId,
		wsManager: c.get('wsManager'),
	});

	const commentText = typeof body.content?.text === 'string' ? body.content.text : '';
	if (commentText) {
		recordTaskLinks(db, teamId, taskId, commentText, authorMemberId, c.get('wsManager')).catch(
			(e) => log.error('Failed to record task links from comment:', e),
		);
	}

	broadcastChange(
		c,
		wsRoom.team(teamId),
		'task_comments',
		'INSERT',
		result.rows[0] as Record<string, unknown>,
	);
	if (attachmentIds.length > 0) {
		broadcastChange(c, wsRoom.team(teamId), 'comment_attachments', 'INSERT', {
			comment_id: result.rows[0].id,
			asset_ids: attachmentIds,
		});
	}

	const masterKeyManager = c.get('masterKeyManager');
	const attachments = await loadAttachmentsForComments(db, [result.rows[0].id], masterKeyManager);
	const created = {
		...(result.rows[0] as Record<string, unknown>),
		attachments: attachments.get(result.rows[0].id) ?? [],
	};
	return ok(c, created, 201);
});

commentsRoutes.post('/projects/:projectId/tasks/:taskId/comments/:commentId/choose', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const taskId = await resolveTaskId(db, teamId, c.req.param('taskId'));
	if (!taskId) return err(c, 'NOT_FOUND', 'Task not found', 404);
	const commentId = c.req.param('commentId');

	const body = await c.req.json<{ chosen_id: string }>();
	if (!body.chosen_id) {
		return err(c, 'INVALID_REQUEST', 'chosen_id is required', 400);
	}

	// Verify comment belongs to the task
	const existing = await db.query<{ content_type: string; task_id: string }>(
		'SELECT content_type, task_id FROM task_comments WHERE id = $1 AND task_id = $2',
		[commentId, taskId],
	);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Comment not found', 404);
	}
	if (existing.rows[0].content_type !== CommentContentType.Options) {
		return err(c, 'INVALID_REQUEST', 'Can only choose on options-type comments', 400);
	}

	const result = await withTransaction(db, async () => {
		const updated = await db.query(
			'UPDATE task_comments SET chosen_option = $1::jsonb WHERE id = $2 RETURNING *',
			[JSON.stringify({ chosen_id: body.chosen_id }), commentId],
		);

		await db.query(
			`INSERT INTO task_comments (task_id, content_type, content)
         VALUES ($1, $2::comment_content_type, $3::jsonb)`,
			[
				existing.rows[0].task_id,
				CommentContentType.System,
				JSON.stringify({ text: `Admin selected option: ${body.chosen_id}` }),
			],
		);
		return updated;
	});

	const task = await db.query<{ assignee_id: string | null }>(
		'SELECT assignee_id FROM tasks WHERE id = $1',
		[existing.rows[0].task_id],
	);
	const assigneeId = task.rows[0]?.assignee_id;
	if (assigneeId) {
		const isAgent = await db.query('SELECT id FROM member_agents WHERE id = $1', [assigneeId]);
		if (isAgent.rows.length > 0) {
			trackBackground(
				createWakeup(db, assigneeId, teamId, WakeupSource.OptionChosen, {
					task_id: existing.rows[0].task_id,
					chosen_id: body.chosen_id,
				}).catch((e) => log.error('Failed to create option_chosen wakeup:', e)),
			);
		}
	}

	broadcastChange(
		c,
		wsRoom.team(teamId),
		'task_comments',
		'UPDATE',
		result.rows[0] as Record<string, unknown>,
	);
	return ok(c, result.rows[0]);
});

commentsRoutes.post(
	'/projects/:projectId/tasks/:taskId/comments/:commentId/fulfill-credential',
	async (c) => {
		const teamId = c.get('teamId') as string;
		const db = c.get('db');
		const masterKeyManager = c.get('masterKeyManager');
		const taskId = await resolveTaskId(db, teamId, c.req.param('taskId'));
		if (!taskId) return err(c, 'NOT_FOUND', 'Task not found', 404);
		const commentId = c.req.param('commentId');

		const body = await c.req.json<{ value?: string; confirmed?: boolean }>();

		const existing = await db.query<{
			content_type: string;
			task_id: string;
			content: Record<string, unknown>;
			chosen_option: Record<string, unknown> | null;
			author_member_id: string | null;
		}>(
			'SELECT content_type, task_id, content, chosen_option, author_member_id FROM task_comments WHERE id = $1 AND task_id = $2',
			[commentId, taskId],
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
		const scope = String(requestContent.scope ?? 'team');
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

		const { secretId, updatedComment } = await withTransaction(db, async () => {
			const encryptedValue = isConfirmation ? '' : encrypt(storedValue as string, encryptionKey);
			const category = pickSecretCategory(kind);

			const upsert = await db.query<{ id: string }>(
				`INSERT INTO secrets (team_id, project_id, name, encrypted_value, category, allowed_hosts)
				 VALUES ($1, $2, $3, $4, $5::secret_category, $6::text[])
				 ON CONFLICT (team_id, project_id, name)
				 DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value,
				               category = EXCLUDED.category,
				               allowed_hosts = EXCLUDED.allowed_hosts,
				               updated_at = now()
				 RETURNING id`,
				[teamId, projectId, name, encryptedValue, category, allowedHosts],
			);
			const secretId = upsert.rows[0].id;

			if (requestingAgentId) {
				await db.query(
					`INSERT INTO secret_grants (secret_id, member_id, scope)
					 VALUES ($1, $2, $3::grant_scope)
					 ON CONFLICT (secret_id, member_id) DO NOTHING`,
					[secretId, requestingAgentId, GrantScope.Single],
				);
			}

			const updated = await db.query(
				`UPDATE task_comments
				   SET chosen_option = $1::jsonb
				 WHERE id = $2
				 RETURNING *`,
				[
					JSON.stringify({ secret_id: secretId, fulfilled_at: new Date().toISOString() }),
					commentId,
				],
			);

			await db.query(
				`INSERT INTO task_comments (task_id, content_type, content)
				 VALUES ($1, 'system'::comment_content_type, $2::jsonb)`,
				[
					taskId,
					JSON.stringify({
						text: isConfirmation
							? `Confirmed: ${name}`
							: `Credential provided: ${name} (stored as secret, value not shown)`,
					}),
				],
			);
			return {
				secretId,
				updatedComment: updated.rows[0] as Record<string, unknown>,
			};
		});

		if (requestingAgentId) {
			const isAgent = await db.query('SELECT id FROM member_agents WHERE id = $1', [
				requestingAgentId,
			]);
			if (isAgent.rows.length > 0) {
				try {
					await createWakeup(db, requestingAgentId, teamId, WakeupSource.CredentialProvided, {
						task_id: taskId,
						comment_id: commentId,
						secret_id: secretId,
						name,
					});
				} catch (e) {
					log.error('Failed to create credential_provided wakeup:', e);
				}
			}
		}

		broadcastChange(c, wsRoom.team(teamId), 'task_comments', 'UPDATE', updatedComment);
		const actor = await resolveActor(db, c.get('auth'), teamId);
		c.get('events').emit({
			type: 'credential.fulfilled',
			teamId,
			projectId,
			actorType: actor.actorType,
			actorMemberId: actor.actorMemberId,
			secretId,
			name,
			requestingAgentId,
		});
		return ok(c, { secret_id: secretId, comment_id: commentId });
	},
);

interface CommentAttachmentRow {
	comment_id: string;
	id: string;
	content_type: string;
	byte_size: number;
	original_filename: string;
}

async function loadAttachmentsForComments(
	db: import('@electric-sql/pglite').PGlite,
	commentIds: string[],
	masterKeyManager: import('../crypto/master-key').MasterKeyManager,
): Promise<
	Map<
		string,
		Array<{
			id: string;
			content_type: string;
			byte_size: number;
			original_filename: string;
			url: string;
		}>
	>
> {
	if (commentIds.length === 0) return new Map();
	const rows = await db.query<CommentAttachmentRow>(
		`SELECT ca.comment_id, a.id, a.content_type, a.byte_size, a.original_filename
		 FROM comment_attachments ca
		 JOIN assets a ON a.id = ca.asset_id
		 WHERE ca.comment_id = ANY($1::uuid[])
		 ORDER BY ca.created_at ASC`,
		[commentIds],
	);
	const out = new Map<
		string,
		Array<{
			id: string;
			content_type: string;
			byte_size: number;
			original_filename: string;
			url: string;
		}>
	>();
	for (const row of rows.rows) {
		const url = await signAssetUrl(row.id, masterKeyManager);
		const list = out.get(row.comment_id) ?? [];
		list.push({
			id: row.id,
			content_type: row.content_type,
			byte_size: row.byte_size,
			original_filename: row.original_filename,
			url,
		});
		out.set(row.comment_id, list);
	}
	return out;
}

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
