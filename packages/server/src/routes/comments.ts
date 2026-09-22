import {
	COMMENT_ATTACHMENTS_MAX,
	CommentContentType,
	commentHasContent,
	commentTextFits,
	parseThreadRowCategories,
	type ThreadRowCategory,
	WakeupSource,
	wsRoom,
} from '@hezo/shared';
import { Hono } from 'hono';
import { encrypt } from '../crypto/encryption';
import type { MasterKeyManager } from '../crypto/master-key';
import { agentDisplayNameSql } from '../lib/agent-identity';
import { signAssetUrl } from '../lib/asset-urls';
import { broadcastChange, broadcastCommentFamilyChange } from '../lib/broadcast';
import {
	commentCategoryPredicate,
	commentSincePredicate,
	isValidSince,
} from '../lib/comment-filters';
import { attachRunStatuses } from '../lib/comment-run-status';
import { normalizeAllowedHosts } from '../lib/credential-placeholder';
import { validateCredentialValue } from '../lib/credential-validator';
import { signAuthorIconUrl } from '../lib/entity-icon-urls';
import {
	actingPersonFromAuth,
	resolveActor,
	resolveReactorMemberId,
	resolveTaskId,
} from '../lib/resolve';
import { err, ok } from '../lib/response';
import { withTransaction } from '../lib/sql';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { requireAdminEquivalent } from '../middleware/auth';
import { checkProjectAssetIds } from '../services/asset-ownership';
import {
	commentTooLongError,
	postComment,
	resumeHeldTaskOnAdminReply,
} from '../services/comment-wakeups';
import { parseEffortFromCommentBody } from '../services/effort';
import { invalidateSecretsVault } from '../services/egress';
import {
	addCommentReaction,
	loadReactionsForTask,
	removeCommentReaction,
} from '../services/reactions';
import { insertSystemComment } from '../services/task-events';
import { createWakeup } from '../services/wakeup';

const log = logger.child('routes');

/** Every kind the `comment_content_type` enum holds, so an unknown one is a 400. */
const COMMENT_CONTENT_TYPES: ReadonlySet<string> = new Set(Object.values(CommentContentType));

/** Comment kinds only the server writes, refused on the create route. */
const SERVER_WRITTEN_CONTENT_TYPES: ReadonlySet<string> = new Set([
	CommentContentType.System,
	CommentContentType.Run,
]);

export const commentsRoutes = new Hono<Env>();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_IDS = 100;

/**
 * Resolve each comment row's `author_icon_url` (a freshly-signed avatar URL) from
 * the icon-version subselect the author queries carry, then strip those
 * intermediate fields from the row. Only a human author has one, keyed by
 * `author_user_id`; an agent ships `author_avatar_spec` instead and its sprite is
 * drawn client-side, and an API-key author has neither. Best-effort: a signing
 * failure (e.g. the master key being unavailable) degrades the row to its initials
 * fallback rather than failing the whole thread — the avatar is purely cosmetic.
 */
async function attachAuthorIcons(
	masterKeyManager: MasterKeyManager,
	rows: Record<string, unknown>[],
): Promise<void> {
	for (const row of rows) {
		row.author_icon_url = await signAuthorIconUrl(masterKeyManager, {
			userId: row.author_user_id,
			userIconUpdatedAt: row.author_user_icon_updated_at,
		});
		delete row.author_user_id;
		delete row.author_user_icon_updated_at;
	}
}

/**
 * Comments feed. Three response shapes on the one endpoint so a long thread can
 * render placeholders for every row up front and load the heavy bodies on demand
 * as the user scrolls, while small callers (e.g. the intake chat) keep the
 * one-shot full payload:
 *
 *  - **full mode** (default): the original payload — every comment with `content`,
 *    `reactions` and `attachments`. Used by callers that render the whole thread
 *    inline (intake chat) and by API clients.
 *  - **skeleton mode** (`?view=skeleton`): one row per comment with metadata +
 *    reactions (one cheap query, the single source of truth for reaction state).
 *    Text comments omit their `content` body and `attachments` (the heavy parts —
 *    large markdown and per-attachment signed URLs), carrying instead a
 *    `text_length` hint (placeholder sizing) and an `attachment_count`. Non-text
 *    comments keep their small structural `content` + `chosen_option`.
 *  - **body mode** (`?ids=a,b,c`): the deferred heavy payload — `content` and
 *    `attachments` for just the requested comments. Reactions stay on the skeleton
 *    row, so a row merges body content over its skeleton entry.
 *
 * Full and skeleton mode accept `?categories=` and `?since=` — the same filter
 * the MCP `list_comments` tool takes, so both surfaces narrow a thread the same
 * way. **They default to every row here and to the conversation on MCP**, and the
 * difference is deliberate: this endpoint feeds a browser that folds the
 * machinery itself and counts run and system rows to label the folded groups,
 * while an agent's scarce resource is the context window it reads them into.
 * Body mode ignores both — it is keyed by explicit ids, so returning fewer rows
 * than were named would be a different answer to the question asked.
 */
commentsRoutes.get('/projects/:projectId/tasks/:taskId/comments', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const taskId = await resolveTaskId(db, teamId, c.req.param('taskId'));
	if (!taskId) return err(c, 'NOT_FOUND', 'Task not found', 404);

	const idsParam = c.req.query('ids');
	if (idsParam !== undefined) return getCommentBodies(c, db, taskId, idsParam);

	const categoriesParam = c.req.query('categories');
	const categories =
		categoriesParam === undefined ? null : parseThreadRowCategories(categoriesParam);
	if (categoriesParam !== undefined && !categories) {
		return err(c, 'BAD_REQUEST', 'Unknown categories value', 400);
	}
	const since = c.req.query('since');
	if (since !== undefined && !isValidSince(since)) {
		return err(c, 'BAD_REQUEST', 'since must be an ISO-8601 timestamp', 400);
	}
	const filter: CommentReadFilter = { categories, since };

	if (c.req.query('view') === 'skeleton') {
		return getCommentSkeletons(c, db, teamId, taskId, filter);
	}
	return getCommentsFull(c, db, teamId, taskId, filter);
});

/** Which rows a thread read wants. A null `categories` means every row. */
interface CommentReadFilter {
	categories: ThreadRowCategory[] | null;
	since?: string;
}

/**
 * The filter's `AND` clauses for a query already keyed on `ic.task_id`, pushing
 * their bind params onto `params`. Empty string when nothing was asked for, so
 * the unfiltered read is byte-identical to what it was.
 */
function commentFilterClauses(filter: CommentReadFilter, params: unknown[]): string {
	const parts = [
		filter.categories ? commentCategoryPredicate('ic', filter.categories, params) : null,
		commentSincePredicate('ic', filter.since, params),
	].filter((p): p is string => p !== null);
	return parts.length > 0 ? ` AND ${parts.join(' AND ')}` : '';
}

/** Full mode (default): every comment with content, reactions and attachments. */
async function getCommentsFull(
	c: import('hono').Context<Env>,
	db: import('../db/database').Db,
	teamId: string,
	taskId: string,
	filter: CommentReadFilter,
) {
	const params: unknown[] = [taskId];
	const filterSql = commentFilterClauses(filter, params);
	const result = await db.query(
		`SELECT ic.id, ic.public_id, ic.task_id, ic.content_type, ic.content, ic.chosen_option, ic.created_at,
            CASE WHEN ic.author_api_key_id IS NOT NULL THEN 'api_key' ELSE m.member_type::text END AS author_type,
            COALESCE(ca.name, ${agentDisplayNameSql('ma', 'm')}, 'Admin') AS author_name,
            ic.author_member_id,
            ic.author_api_key_id,
            ic.author_user_id,
            ui.updated_at AS author_user_icon_updated_at,
            ma.avatar_spec AS author_avatar_spec,
            ic.parent_comment_id
     FROM task_comments ic
     LEFT JOIN members m ON m.id = ic.author_member_id
     LEFT JOIN member_agents ma ON ma.id = ic.author_member_id
     LEFT JOIN api_keys ca ON ca.id = ic.author_api_key_id
     LEFT JOIN user_icons ui ON ui.user_id = ic.author_user_id
     WHERE ic.task_id = $1${filterSql}
     -- id breaks ties deterministically: comments created in the same instant
     -- (a seeded thread, a burst of system comments) otherwise come back in
     -- whatever order the plan happens to produce, so the thread can reorder
     -- between two identical requests and a deep link lands on the wrong row.
     -- The (task_id, created_at) index still serves the sort.
     ORDER BY ic.created_at ASC, ic.id ASC`,
		params,
	);

	const viewerMemberId = await resolveReactorMemberId(db, c.get('auth'), teamId);
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

	await attachRunStatuses(db, taskId, result.rows as Record<string, unknown>[]);
	await attachAuthorIcons(c.get('masterKeyManager'), result.rows as Record<string, unknown>[]);
	return ok(c, result.rows);
}

/**
 * `?view=skeleton` mode: metadata + reactions for every comment, with text
 * bodies and attachments omitted (replaced by `text_length` / `attachment_count`
 * hints). Non-text comments keep their small `content` + `chosen_option`, and a
 * run comment carries its run's outcome as `run_status` - the thread summarizes
 * itself from these rows, and a folded run row is never rendered, so it would
 * otherwise have no way to know the run failed.
 */
async function getCommentSkeletons(
	c: import('hono').Context<Env>,
	db: import('../db/database').Db,
	teamId: string,
	taskId: string,
	filter: CommentReadFilter,
) {
	const params: unknown[] = [taskId];
	const filterSql = commentFilterClauses(filter, params);
	const result = await db.query(
		`SELECT ic.id, ic.public_id, ic.task_id, ic.content_type,
            CASE WHEN ic.content_type = 'text' THEN NULL ELSE ic.content END AS content,
            ic.chosen_option, ic.created_at,
            CASE WHEN ic.author_api_key_id IS NOT NULL THEN 'api_key' ELSE m.member_type::text END AS author_type,
            COALESCE(ca.name, ${agentDisplayNameSql('ma', 'm')}, 'Admin') AS author_name,
            ic.author_member_id,
            ic.author_api_key_id,
            ic.author_user_id,
            ui.updated_at AS author_user_icon_updated_at,
            ma.avatar_spec AS author_avatar_spec,
            ic.parent_comment_id,
            CASE WHEN ic.content_type = 'text'
                 THEN COALESCE(length(ic.content->>'text'), 0) ELSE NULL END AS text_length,
            COALESCE(att.n, 0) AS attachment_count
     FROM task_comments ic
     LEFT JOIN members m ON m.id = ic.author_member_id
     LEFT JOIN member_agents ma ON ma.id = ic.author_member_id
     LEFT JOIN api_keys ca ON ca.id = ic.author_api_key_id
     LEFT JOIN user_icons ui ON ui.user_id = ic.author_user_id
     LEFT JOIN (
       SELECT cat.comment_id, count(*)::int AS n
       FROM comment_attachments cat
       JOIN task_comments tc ON tc.id = cat.comment_id
       WHERE tc.task_id = $1
       GROUP BY cat.comment_id
     ) att ON att.comment_id = ic.id
     WHERE ic.task_id = $1${filterSql}
     -- id breaks ties deterministically: comments created in the same instant
     -- (a seeded thread, a burst of system comments) otherwise come back in
     -- whatever order the plan happens to produce, so the thread can reorder
     -- between two identical requests and a deep link lands on the wrong row.
     -- The (task_id, created_at) index still serves the sort.
     ORDER BY ic.created_at ASC, ic.id ASC`,
		params,
	);

	const viewerMemberId = await resolveReactorMemberId(db, c.get('auth'), teamId);
	const reactionsByComment = await loadReactionsForTask(db, taskId, viewerMemberId);
	for (const comment of result.rows as Record<string, unknown>[]) {
		comment.reactions = reactionsByComment.get(comment.id as string) ?? [];
	}

	await attachRunStatuses(db, taskId, result.rows as Record<string, unknown>[]);
	await attachAuthorIcons(c.get('masterKeyManager'), result.rows as Record<string, unknown>[]);
	return ok(c, result.rows);
}

/**
 * `?ids=` body mode: return `{ id, content, attachments }` for the requested
 * comments only. Ids are validated to belong to this task, so body mode can
 * never surface a comment from another task. Reactions are intentionally not
 * returned here — they live on the skeleton row (one source of truth).
 */
async function getCommentBodies(
	c: import('hono').Context<Env>,
	db: import('../db/database').Db,
	taskId: string,
	idsParam: string,
) {
	const ids = idsParam
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	if (ids.length === 0) return ok(c, []);
	if (ids.length > MAX_BODY_IDS) {
		return err(c, 'INVALID_REQUEST', `Too many ids (max ${MAX_BODY_IDS})`, 400);
	}
	if (ids.some((id) => !UUID_RE.test(id))) {
		return err(c, 'INVALID_REQUEST', 'ids must be UUIDs', 400);
	}

	const result = await db.query<{ id: string; content: unknown; task_id: string }>(
		`SELECT ic.id, ic.content, ic.task_id
     FROM task_comments ic
     WHERE ic.id = ANY($1::uuid[])`,
		[ids],
	);
	// Security: never surface a comment from another task. An id that resolves to a
	// different task is a cross-task request and is rejected outright. Ids that
	// simply don't exist (deleted mid-scroll) are tolerated — omitted from the
	// response — so a race doesn't fail the whole batch.
	if (result.rows.some((row) => row.task_id !== taskId)) {
		return err(c, 'NOT_FOUND', 'One or more comments do not belong to this task', 404);
	}

	const foundIds = result.rows.map((r) => r.id);
	const attachmentsByComment = await loadAttachmentsForComments(
		db,
		foundIds,
		c.get('masterKeyManager'),
	);

	const bodies = result.rows.map((row) => ({
		id: row.id,
		content: row.content,
		attachments: attachmentsByComment.get(row.id) ?? [],
	}));
	return ok(c, bodies);
}

commentsRoutes.put(
	'/projects/:projectId/tasks/:taskId/comments/:commentId/reactions/:kind',
	async (c) => {
		const teamId = c.get('teamId') as string;
		const db = c.get('db');
		const taskId = await resolveTaskId(db, teamId, c.req.param('taskId'));
		if (!taskId) return err(c, 'NOT_FOUND', 'Task not found', 404);
		const commentId = c.req.param('commentId');
		const kind = c.req.param('kind');

		const memberId = await resolveReactorMemberId(db, c.get('auth'), teamId);
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

		const memberId = await resolveReactorMemberId(db, c.get('auth'), teamId);
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

	const taskCheck = await db.query<{ id: string; assignee_id: string | null; project_id: string }>(
		'SELECT id, assignee_id, project_id FROM tasks WHERE id = $1 AND team_id = $2',
		[taskId, teamId],
	);
	if (taskCheck.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Task not found', 404);
	}

	const body = await c.req.json<{
		content_type?: string;
		content: Record<string, unknown> | string;
		effort?: string;
		parent_comment_id?: string | null;
		attachment_ids?: string[];
	}>();

	const attachmentCheck = await checkProjectAssetIds(
		db,
		taskCheck.rows[0].project_id,
		body.attachment_ids,
		COMMENT_ATTACHMENTS_MAX,
	);
	if (!attachmentCheck.ok) return err(c, 'INVALID_REQUEST', attachmentCheck.message, 400);
	const attachmentIds = attachmentCheck.ids;
	const contentType = body.content_type ?? CommentContentType.Text;
	// Hezo writes system notices and run cards itself. A caller posting one would
	// forge a hold notice or a run the thread never had.
	if (SERVER_WRITTEN_CONTENT_TYPES.has(contentType)) {
		return err(c, 'INVALID_REQUEST', `content_type ${contentType} is written by Hezo only`, 400);
	}
	// A kind the enum does not hold would otherwise fail at the cast, as a 500 the
	// caller cannot act on.
	if (!COMMENT_CONTENT_TYPES.has(contentType)) {
		return err(c, 'INVALID_REQUEST', `Unknown content_type: ${contentType}`, 400);
	}
	// The web composer sends a text comment's words as a bare string; stored, every
	// text comment has the one shape agents also write.
	const content: Record<string, unknown> | null =
		typeof body.content === 'string'
			? { text: body.content }
			: body.content && typeof body.content === 'object'
				? body.content
				: null;
	if (!content) return err(c, 'INVALID_REQUEST', 'content is required', 400);
	if (contentType === CommentContentType.Text) {
		const text = typeof content.text === 'string' ? content.text : '';
		if (!commentHasContent(text, attachmentIds.length)) {
			return err(c, 'INVALID_REQUEST', 'content or attachment_ids is required', 400);
		}
		if (!commentTextFits(text)) {
			return err(c, 'COMMENT_TOO_LONG', commentTooLongError(text.length), 400);
		}
	} else if (!commentTextFits(JSON.stringify(content))) {
		// A structured comment comes back whole in a thread read, so one oversized
		// card would push every page carrying it past the reader's cap. The whole
		// serialized row is held to the text limit rather than only its prose.
		return err(c, 'COMMENT_TOO_LONG', commentTooLongError(JSON.stringify(content).length), 400);
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

	// REST is the people's surface: a human author keeps `author_member_id` null by
	// convention, and `author_user_id` records *which* human, so their avatar
	// (user_icons) renders on the comment.
	const person = actingPersonFromAuth(auth);
	const { row } = await postComment({
		db,
		wsManager: c.get('wsManager'),
		teamId,
		projectId: c.get('projectId') as string,
		taskId,
		author: { memberId: null, userId: person.user_id, apiKeyId: person.api_key_id },
		parentCommentId,
		contentType: contentType as CommentContentType,
		content,
		effort: commentEffort,
		attachmentIds,
	});

	const masterKeyManager = c.get('masterKeyManager');
	const attachments = await loadAttachmentsForComments(db, [row.id], masterKeyManager);
	const created = { ...row, attachments: attachments.get(row.id) ?? [] };
	return ok(c, created, 201);
});

commentsRoutes.post(
	'/projects/:projectId/tasks/:taskId/comments/:commentId/fulfill-credential',
	async (c) => {
		// This writes the instance's secrets table, as `POST /secrets` does, so it
		// asks for the same principal rather than project access alone.
		const denied = requireAdminEquivalent(c);
		if (denied) return denied;
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
			replace_existing?: boolean;
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
		// Both sides go through the shared normalizer, so a host the agent
		// requested as `https://api.foo.com` is stored in the bare-hostname shape
		// the proxy actually compares against rather than silently never matching.
		const requestHosts = normalizeAllowedHosts(requestContent.allowed_hosts);
		// The human pasting the value can set or correct the host allowlist —
		// the safety net when an agent requested an exempt kind (other/webhook)
		// without scoping, leaving the secret undeliverable. A non-empty override
		// wins; otherwise the agent's requested hosts stand.
		const overrideHosts = normalizeAllowedHosts(body.allowed_hosts);
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

		const result = await withTransaction(db, async () => {
			const encryptedValue = isConfirmation ? '' : encrypt(storedValue as string, encryptionKey);
			const category = pickSecretCategory(kind);

			// The agent chose this name. A name that already holds a secret is a
			// different credential's row, so the write only replaces one when the
			// person says so - and it never lets the request card decide where an
			// existing credential may be sent.
			const standing = await db.query<{ id: string; allowed_hosts: string[] }>(
				'SELECT id, allowed_hosts FROM secrets WHERE name = $1 FOR UPDATE',
				[name],
			);
			const existingSecret = standing.rows[0];
			if (existingSecret && body.replace_existing !== true) return { conflict: name } as const;
			const hosts =
				existingSecret && overrideHosts.length === 0 ? existingSecret.allowed_hosts : allowedHosts;

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
				[name, encryptedValue, category, hosts, allowBodySubstitution],
			);
			const secretId = upsert.rows[0].id;
			invalidateSecretsVault();

			const updated = await db.query(
				`UPDATE task_comments
				   SET chosen_option = $1::jsonb, chosen_by_user_id = $3
				 WHERE id = $2
				 RETURNING *`,
				[
					JSON.stringify({ secret_id: secretId, fulfilled_at: new Date().toISOString() }),
					commentId,
					actingPersonFromAuth(c.get('auth')).user_id,
				],
			);

			await insertSystemComment(db, {
				taskId,
				content: {
					text: isConfirmation
						? `Confirmed: ${name}`
						: `Credential provided: ${name} (stored as secret, value not shown)`,
				},
			});
			return {
				secretId,
				updatedComment: updated.rows[0] as Record<string, unknown>,
			} as const;
		});

		if ('conflict' in result) {
			return err(
				c,
				'SECRET_EXISTS',
				`A secret named ${result.conflict} already exists. Send replace_existing: true to overwrite it, or ask for a different name.`,
				409,
			);
		}
		const { secretId, updatedComment } = result;

		// Clear the request's inbox rows — providing the value IS acting on them,
		// for every admin, not only whoever happened to open the form.
		try {
			await db.query(
				'UPDATE admin_mentions SET read_at = COALESCE(read_at, now()) WHERE comment_id = $1',
				[commentId],
			);
			broadcastChange(c, wsRoom.team(teamId), 'admin_mentions', 'UPDATE', {
				comment_id: commentId,
				team_id: teamId,
				project_id: c.get('projectId') as string,
			});
		} catch (e) {
			log.error('Failed to mark credential-request mentions read:', e);
		}

		// The answer is the admin's word on the task too, so a hold waiting for it
		// lifts and the task's own assignee runs, whoever asked for the credential.
		await resumeHeldTaskOnAdminReply({ db, taskId, teamId, commentId }).catch((e) =>
			log.error('Failed to resume a held task after a credential answer:', e),
		);

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
						decided_by: actingPersonFromAuth(c.get('auth')),
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
		const decider = actingPersonFromAuth(c.get('auth'));

		let deletedIds: string[] = [];
		let deletedPaths: string[] = [];
		let updatedComment: Record<string, unknown>;

		if (body.approve) {
			const result = await withTransaction(db, async () => {
				// Delete by id, re-selecting first: an asset may have been renamed or
				// separately deleted since the request. Renamed assets still delete
				// (the admin approved the request-time snapshot; the system comment
				// reports current paths); already-gone ids are recorded, not errored.
				// Ordered by the request, because three things downstream read this order
				// and none of them should vary: the summary comment lists the filenames,
				// the stored outcome lists the ids, and the audit row records the first
				// id as the entity the deletion was about. Unordered, all three followed
				// whatever plan the row count and available indexes happened to produce,
				// so adding an index elsewhere silently renamed the audited asset.
				const current = await db.query<{ id: string; original_filename: string }>(
					`SELECT id, original_filename FROM assets
					  WHERE id = ANY($1::uuid[]) AND team_id = $2 AND project_id = $3
					  ORDER BY array_position($1::uuid[], id)`,
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
					`UPDATE task_comments SET chosen_option = $1::jsonb, chosen_by_user_id = $3
					  WHERE id = $2 RETURNING *`,
					[
						JSON.stringify({ status: 'approved', resolved_at: resolvedAt, deleted_asset_ids: ids }),
						commentId,
						decider.user_id,
					],
				);

				const summary =
					`Asset deletion approved: ${ids.length} deleted` +
					(paths.length > 0 ? ` (${paths.map((p) => `assets/${p}`).join(', ')})` : '') +
					(missing > 0 ? `; ${missing} no longer existed` : '');
				await insertSystemComment(db, { taskId, content: { text: summary } });
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
					`UPDATE task_comments SET chosen_option = $1::jsonb, chosen_by_user_id = $3
					  WHERE id = $2 RETURNING *`,
					[
						JSON.stringify({ status: 'denied', resolved_at: resolvedAt }),
						commentId,
						decider.user_id,
					],
				);
				const refs = requestedAssets.map((a) => `assets/${a.path}`).join(', ');
				await insertSystemComment(db, {
					taskId,
					content: { text: `Asset deletion denied: ${refs}` },
				});
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

		await resumeHeldTaskOnAdminReply({ db, taskId, teamId, commentId }).catch((e) =>
			log.error('Failed to resume a held task after an asset-deletion answer:', e),
		);

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
						decided_by: decider,
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
