import { AuthType, CommentContentType, WakeupSource, wsRoom } from '@hezo/shared';
import { Hono } from 'hono';
import { encrypt } from '../crypto/encryption';
import { signAssetUrl } from '../lib/asset-urls';
import { broadcastChange, broadcastCommentFamilyChange } from '../lib/broadcast';
import { validateCredentialValue } from '../lib/credential-validator';
import {
	apiKeyIdFromAuth,
	resolveActor,
	resolveActorMemberId,
	resolveTaskId,
} from '../lib/resolve';
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

	const result = await db.query(
		`SELECT ic.id, ic.public_id, ic.task_id, ic.content_type, ic.content, ic.chosen_option, ic.created_at,
            CASE WHEN ic.author_api_key_id IS NOT NULL THEN 'api_key' ELSE m.member_type::text END AS author_type,
            COALESCE(ca.name, ma.title, m.display_name, 'Admin') AS author_name,
            ic.author_member_id,
            ic.author_api_key_id,
            ic.parent_comment_id
     FROM task_comments ic
     LEFT JOIN members m ON m.id = ic.author_member_id
     LEFT JOIN member_agents ma ON ma.id = ic.author_member_id
     LEFT JOIN api_keys ca ON ca.id = ic.author_api_key_id
     WHERE ic.task_id = $1
     ORDER BY ic.created_at ASC`,
		[taskId],
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

		broadcastCommentFamilyChange(
			c.get('wsManager'),
			teamId,
			c.get('projectId') as string,
			'comment_reactions',
			'INSERT',
			{
				comment_id: commentId,
				task_id: taskId,
				member_id: memberId,
				kind,
			},
		);
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

		broadcastCommentFamilyChange(
			c.get('wsManager'),
			teamId,
			c.get('projectId') as string,
			'comment_reactions',
			'DELETE',
			{
				comment_id: commentId,
				task_id: taskId,
				member_id: memberId,
				kind,
			},
		);
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
	// An API key authors as its first-class identity, not a member.
	const authorApiKeyId = apiKeyIdFromAuth(auth);

	const result = await withTransaction(db, async () => {
		const inserted = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, author_api_key_id, parent_comment_id, content_type, content)
     VALUES ($1, $2, $3, $4, $5::comment_content_type, $6::jsonb)
     RETURNING *`,
			[
				taskId,
				authorMemberId,
				authorApiKeyId,
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
		parentCommentId,
		wsManager: c.get('wsManager'),
	});

	const commentText = typeof body.content?.text === 'string' ? body.content.text : '';
	if (commentText) {
		recordTaskLinks(
			db,
			teamId,
			taskId,
			commentText,
			authorMemberId,
			authorApiKeyId,
			c.get('wsManager'),
		).catch((e) => log.error('Failed to record task links from comment:', e));
	}

	broadcastCommentFamilyChange(
		c.get('wsManager'),
		teamId,
		c.get('projectId') as string,
		'task_comments',
		'INSERT',
		result.rows[0] as Record<string, unknown>,
	);
	if (attachmentIds.length > 0) {
		broadcastCommentFamilyChange(
			c.get('wsManager'),
			teamId,
			c.get('projectId') as string,
			'comment_attachments',
			'INSERT',
			{
				comment_id: result.rows[0].id,
				asset_ids: attachmentIds,
			},
		);
	}

	const masterKeyManager = c.get('masterKeyManager');
	const attachments = await loadAttachmentsForComments(db, [result.rows[0].id], masterKeyManager);
	const created = {
		...(result.rows[0] as Record<string, unknown>),
		attachments: attachments.get(result.rows[0].id) ?? [],
	};
	return ok(c, created, 201);
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

		const body = await c.req.json<{
			value?: string;
			confirmed?: boolean;
			allowed_hosts?: string[];
			allow_body_substitution?: boolean;
		}>();

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
		const requestHosts = Array.isArray(requestContent.allowed_hosts)
			? (requestContent.allowed_hosts as string[])
			: [];
		// The human pasting the value can set or correct the host allowlist —
		// the safety net when an agent requested an exempt kind (other/webhook)
		// without scoping, leaving the secret undeliverable. A non-empty override
		// wins; otherwise the agent's requested hosts stand.
		const overrideHosts = Array.isArray(body.allowed_hosts)
			? body.allowed_hosts.map((h) => String(h).trim().toLowerCase()).filter((h) => h.length > 0)
			: [];
		const allowedHosts = overrideHosts.length > 0 ? overrideHosts : requestHosts;
		// Body substitution is a sensitive capability the human must approve. The
		// agent's request (stored in the comment) seeds the form's checkbox; if the
		// fulfiller sends an explicit boolean, their decision (e.g. unchecking) wins.
		const allowBodySubstitution =
			typeof body.allow_body_substitution === 'boolean'
				? body.allow_body_substitution
				: requestContent.allow_body_substitution === true;
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
				`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts, allow_body_substitution)
				 VALUES ($1, $2, $3::secret_category, $4::text[], $5)
				 ON CONFLICT (name)
				 DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value,
				               category = EXCLUDED.category,
				               allowed_hosts = EXCLUDED.allowed_hosts,
				               allow_body_substitution = EXCLUDED.allow_body_substitution,
				               updated_at = now()
				 RETURNING id`,
				[name, encryptedValue, category, allowedHosts, allowBodySubstitution],
			);
			const secretId = upsert.rows[0].id;

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

		broadcastCommentFamilyChange(
			c.get('wsManager'),
			teamId,
			c.get('projectId') as string,
			'task_comments',
			'UPDATE',
			updatedComment,
		);
		const actor = await resolveActor(db, c.get('auth'), teamId);
		c.get('events').emit({
			type: 'credential.fulfilled',
			teamId,
			projectId: null,
			actorType: actor.actorType,
			actorMemberId: actor.actorMemberId,
			actorApiKeyId: actor.actorApiKeyId,
			secretId,
			name,
			requestingAgentId,
		});
		return ok(c, { secret_id: secretId, comment_id: commentId });
	},
);

/**
 * Resolve an agent-filed asset-deletion request: approve (the backend deletes
 * the assets — rows, cascading attachments, and stored bytes — no agent run
 * involved) or deny. Either way the comment's `chosen_option` records the
 * outcome, a system comment lands on the task, the requesting agent is woken,
 * and the request's inbox mentions are marked read.
 */
commentsRoutes.post(
	'/projects/:projectId/tasks/:taskId/comments/:commentId/resolve-asset-deletion',
	async (c) => {
		const teamId = c.get('teamId') as string;
		const projectId = c.get('projectId') as string;
		const auth = c.get('auth');
		// Deletion is destructive and admin-gated by design — an agent (even the
		// requester) must never be able to resolve its own request.
		if (auth.type === AuthType.Agent) {
			return err(c, 'FORBIDDEN', 'Only the admin can resolve asset deletion requests', 403);
		}
		const db = c.get('db');
		const taskId = await resolveTaskId(db, teamId, c.req.param('taskId'));
		if (!taskId) return err(c, 'NOT_FOUND', 'Task not found', 404);
		const commentId = c.req.param('commentId');

		const body = await c.req.json<{ approve?: boolean }>();
		if (typeof body.approve !== 'boolean') {
			return err(c, 'INVALID_REQUEST', 'approve (boolean) is required', 400);
		}

		const existing = await db.query<{
			content: { assets?: Array<{ id?: string; path?: string }> };
			content_type: string;
			chosen_option: Record<string, unknown> | null;
			author_member_id: string | null;
		}>(
			'SELECT content, content_type, chosen_option, author_member_id FROM task_comments WHERE id = $1 AND task_id = $2',
			[commentId, taskId],
		);
		if (existing.rows.length === 0) return err(c, 'NOT_FOUND', 'Comment not found', 404);
		const row = existing.rows[0];
		if (row.content_type !== CommentContentType.AssetDeletionRequest) {
			return err(c, 'INVALID_REQUEST', 'Comment is not an asset deletion request', 400);
		}
		if (row.chosen_option !== null) {
			return err(c, 'INVALID_REQUEST', 'Deletion request already resolved', 400);
		}

		const requestedAssets = (row.content.assets ?? []).filter(
			(a): a is { id: string; path: string } =>
				typeof a.id === 'string' && typeof a.path === 'string',
		);
		const requestedIds = requestedAssets.map((a) => a.id);
		const requestingAgentId = row.author_member_id;
		const resolvedAt = new Date().toISOString();

		let deletedIds: string[] = [];
		let deletedPaths: string[] = [];
		let updatedComment: Record<string, unknown>;

		if (body.approve) {
			const result = await withTransaction(db, async () => {
				// Delete by id, re-selecting first: an asset may have been renamed or
				// separately deleted since the request. Renamed assets still delete
				// (the admin approved the request-time snapshot; the system comment
				// reports current paths); already-gone ids are recorded, not errored.
				const current = await db.query<{ id: string; original_filename: string }>(
					'SELECT id, original_filename FROM assets WHERE id = ANY($1::uuid[]) AND team_id = $2 AND project_id = $3',
					[requestedIds, teamId, projectId],
				);
				const ids = current.rows.map((r) => r.id);
				const paths = current.rows.map((r) => r.original_filename);
				if (ids.length > 0) {
					// Attachment joins cascade with the rows.
					await db.query('DELETE FROM assets WHERE id = ANY($1::uuid[])', [ids]);
				}
				const missing = requestedIds.length - ids.length;

				const updated = await db.query(
					`UPDATE task_comments SET chosen_option = $1::jsonb WHERE id = $2 RETURNING *`,
					[
						JSON.stringify({ status: 'approved', resolved_at: resolvedAt, deleted_asset_ids: ids }),
						commentId,
					],
				);

				const summary =
					`Asset deletion approved: ${ids.length} deleted` +
					(paths.length > 0 ? ` (${paths.map((p) => `assets/${p}`).join(', ')})` : '') +
					(missing > 0 ? `; ${missing} no longer existed` : '');
				await db.query(
					`INSERT INTO task_comments (task_id, content_type, content)
					 VALUES ($1, 'system'::comment_content_type, $2::jsonb)`,
					[taskId, JSON.stringify({ text: summary })],
				);
				return { ids, paths, updated: updated.rows[0] as Record<string, unknown> };
			});
			deletedIds = result.ids;
			deletedPaths = result.paths;
			updatedComment = result.updated;

			// Blob removal is best-effort after commit (same posture as the admin
			// DELETE route); a leftover blob is unreachable without its row.
			for (const id of deletedIds) {
				try {
					await c.get('assetStore').delete(projectId, id);
				} catch (e) {
					log.error('Failed to delete asset blob after approval:', e);
				}
			}
		} else {
			updatedComment = await withTransaction(db, async () => {
				const updated = await db.query(
					`UPDATE task_comments SET chosen_option = $1::jsonb WHERE id = $2 RETURNING *`,
					[JSON.stringify({ status: 'denied', resolved_at: resolvedAt }), commentId],
				);
				const refs = requestedAssets.map((a) => `assets/${a.path}`).join(', ');
				await db.query(
					`INSERT INTO task_comments (task_id, content_type, content)
					 VALUES ($1, 'system'::comment_content_type, $2::jsonb)`,
					[taskId, JSON.stringify({ text: `Asset deletion denied: ${refs}` })],
				);
				return updated.rows[0] as Record<string, unknown>;
			});
		}

		// Clear the request's inbox mentions — resolving IS acting on them.
		try {
			await db.query(
				'UPDATE admin_mentions SET read_at = COALESCE(read_at, now()) WHERE comment_id = $1',
				[commentId],
			);
			broadcastChange(c, wsRoom.team(teamId), 'admin_mentions', 'UPDATE', {
				comment_id: commentId,
				team_id: teamId,
				project_id: projectId,
			});
		} catch (e) {
			log.error('Failed to mark asset-deletion mentions read:', e);
		}

		// Wake the requesting agent with the outcome (mirrors fulfill-credential).
		if (requestingAgentId) {
			const isAgent = await db.query('SELECT id FROM member_agents WHERE id = $1', [
				requestingAgentId,
			]);
			if (isAgent.rows.length > 0) {
				try {
					await createWakeup(db, requestingAgentId, teamId, WakeupSource.AssetDeletionResolved, {
						task_id: taskId,
						comment_id: commentId,
						status: body.approve ? 'approved' : 'denied',
						deleted: deletedPaths,
					});
				} catch (e) {
					log.error('Failed to create asset_deletion_resolved wakeup:', e);
				}
			}
		}

		broadcastCommentFamilyChange(
			c.get('wsManager'),
			teamId,
			projectId,
			'task_comments',
			'UPDATE',
			updatedComment,
		);
		if (deletedIds.length > 0) {
			for (const id of deletedIds) {
				broadcastChange(c, wsRoom.team(teamId), 'assets', 'DELETE', {
					id,
					team_id: teamId,
					project_id: projectId,
				});
			}
			const actor = await resolveActor(db, auth, teamId);
			c.get('events').emit({
				type: 'asset.deleted',
				teamId,
				projectId,
				actorType: actor.actorType,
				actorMemberId: actor.actorMemberId,
				actorApiKeyId: actor.actorApiKeyId,
				assetIds: deletedIds,
				filenames: deletedPaths,
				via: 'deletion_request',
				taskId,
			});
		}

		return ok(c, {
			comment_id: commentId,
			status: body.approve ? 'approved' : 'denied',
			deleted_asset_ids: deletedIds,
		});
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
	db: import('../db/database').Db,
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
