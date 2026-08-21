import {
	ApprovalStatus,
	ApprovalType,
	AuthType,
	CommentContentType,
	markdownToPreviewText,
	wsRoom,
} from '@hezo/shared';
import { Hono } from 'hono';
import { agentDisplayNameSql } from '../lib/agent-identity';
import { broadcastChange } from '../lib/broadcast';
import { signAuthorIconUrl } from '../lib/entity-icon-urls';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';

export const inboxRoutes = new Hono<Env>();

const SNIPPET_MAX_LEN = 180;
/**
 * Chars of the body the Markdown strip runs over. A listing renders up to 200
 * rows and a comment body has no ceiling, so the scan is bounded - far above
 * `SNIPPET_MAX_LEN`, so a cut can never strand syntax inside the kept window.
 */
const SNIPPET_SCAN_LIMIT = 4000;

/**
 * The one line of prose an inbox row shows. Comment bodies are Markdown, so the
 * syntax is stripped: a row is a preview, not a source view, and `**bold**` read
 * literally is what the reader would otherwise see. A comment kind that carries
 * no `text` still has to read as something: a credential request's human-facing
 * `instructions` is that comment's whole point, so it stands in.
 */
function buildSnippet(content: unknown): string {
	if (!content || typeof content !== 'object') return '';
	const fields = content as Record<string, unknown>;
	const body = typeof fields.text === 'string' ? fields.text : fields.instructions;
	if (typeof body !== 'string') return '';
	const stripped = markdownToPreviewText(body.slice(0, SNIPPET_SCAN_LIMIT));
	if (stripped.length <= SNIPPET_MAX_LEN) return stripped;
	return `${stripped.slice(0, SNIPPET_MAX_LEN - 1).trimEnd()}…`;
}

/** The secret being asked for, on a credential-request row only. */
function credentialName(contentType: string, content: unknown): string | null {
	if (contentType !== CommentContentType.CredentialRequest) return null;
	if (!content || typeof content !== 'object') return null;
	const name = (content as Record<string, unknown>).name;
	return typeof name === 'string' && name ? name : null;
}

interface AdminMentionRow {
	id: string;
	team_id: string;
	team_slug: string;
	task_id: string;
	task_identifier: string;
	task_title: string;
	project_slug: string;
	comment_id: string;
	comment_public_id: string;
	content_type: string;
	content: unknown;
	author_member_id: string | null;
	author_user_id: string | null;
	author_user_icon_updated_at: string | null;
	author_avatar_spec: unknown;
	author_display_name: string | null;
	author_slug: string | null;
	created_at: string;
	read_at: string | null;
}

inboxRoutes.get('/projects/:projectId/inbox/mentions', async (c) => {
	const teamId = c.get('teamId') as string;
	const auth = c.get('auth');
	if (auth.type !== AuthType.Admin) {
		return err(c, 'FORBIDDEN', 'Only the admin have an inbox', 403);
	}

	const archived = c.req.query('archived') === 'true';
	const db = c.get('db');

	const result = await db.query<AdminMentionRow>(
		`SELECT bm.id, bm.team_id, t.slug AS team_slug,
		        bm.task_id, i.identifier AS task_identifier, i.title AS task_title,
		        p.slug AS project_slug,
		        bm.comment_id, tc.public_id AS comment_public_id,
		        tc.content_type, tc.content,
		        tc.author_member_id,
		        tc.author_user_id,
		        (SELECT ui.updated_at FROM user_icons ui WHERE ui.user_id = tc.author_user_id)
		          AS author_user_icon_updated_at,
		        ma.avatar_spec AS author_avatar_spec,
		        ${agentDisplayNameSql('ma', 'm')} AS author_display_name,
		        ma.slug AS author_slug,
		        bm.created_at, bm.read_at
		 FROM admin_mentions bm
		 JOIN teams t ON t.id = bm.team_id
		 JOIN tasks i ON i.id = bm.task_id
		 JOIN projects p ON p.id = i.project_id
		 JOIN task_comments tc ON tc.id = bm.comment_id
		 LEFT JOIN members m ON m.id = tc.author_member_id
		 LEFT JOIN member_agents ma ON ma.id = tc.author_member_id
		 WHERE bm.team_id = $1 AND bm.user_id = $2
		   AND (bm.archived_at IS NOT NULL) = $3::boolean
		 ORDER BY bm.created_at DESC
		 LIMIT 200`,
		[teamId, auth.userId, archived],
	);

	const masterKeyManager = c.get('masterKeyManager');

	return ok(
		c,
		await Promise.all(
			result.rows.map(async (r) => ({
				id: r.id,
				team_id: r.team_id,
				team_slug: r.team_slug,
				task_id: r.task_id,
				task_identifier: r.task_identifier,
				task_title: r.task_title,
				project_slug: r.project_slug,
				comment_id: r.comment_id,
				comment_public_id: r.comment_public_id,
				content_type: r.content_type,
				credential_name: credentialName(r.content_type, r.content),
				snippet: buildSnippet(r.content),
				author_member_id: r.author_member_id,
				author_display_name: r.author_display_name ?? 'Admin',
				author_slug: r.author_slug,
				// A human author's uploaded avatar. An agent is drawn from its own
				// `avatar_spec`, and the built-in CEO/Coach portraits resolve
				// client-side from the slug.
				author_icon_url: await signAuthorIconUrl(masterKeyManager, {
					userId: r.author_user_id,
					userIconUpdatedAt: r.author_user_icon_updated_at,
				}),
				author_avatar_spec: r.author_avatar_spec,
				created_at: r.created_at,
				read_at: r.read_at,
			})),
		),
	);
});

inboxRoutes.get('/projects/:projectId/inbox/count', async (c) => {
	const teamId = c.get('teamId') as string;
	const auth = c.get('auth');
	if (auth.type !== AuthType.Admin) {
		return err(c, 'FORBIDDEN', 'Only the admin have an inbox', 403);
	}

	const db = c.get('db');
	const result = await db.query<{ unread: number }>(
		`SELECT (
		          (SELECT count(*) FROM admin_mentions
		           WHERE team_id = $1 AND user_id = $2
		             AND read_at IS NULL AND archived_at IS NULL)
		        + (SELECT count(*) FROM approvals
		           WHERE team_id = $1 AND status = $3::approval_status
		             AND archived_at IS NULL)
		        )::int AS unread`,
		[teamId, auth.userId, ApprovalStatus.Pending],
	);

	return ok(c, { unread: result.rows[0]?.unread ?? 0 });
});

inboxRoutes.post('/projects/:projectId/inbox/mentions/:mentionId/read', async (c) => {
	const teamId = c.get('teamId') as string;
	const auth = c.get('auth');
	if (auth.type !== AuthType.Admin) {
		return err(c, 'FORBIDDEN', 'Only the admin have an inbox', 403);
	}

	const mentionId = c.req.param('mentionId');
	const db = c.get('db');

	const updated = await db.query<{ id: string; team_id: string; read_at: string }>(
		`UPDATE admin_mentions
		 SET read_at = COALESCE(read_at, now())
		 WHERE id = $1 AND team_id = $2 AND user_id = $3
		 RETURNING id, team_id, read_at`,
		[mentionId, teamId, auth.userId],
	);

	if (updated.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Mention not found', 404);
	}

	broadcastChange(c, wsRoom.team(teamId), 'admin_mentions', 'UPDATE', {
		id: updated.rows[0].id,
		team_id: teamId,
		user_id: auth.userId,
		read_at: updated.rows[0].read_at,
	});

	return ok(c, { id: updated.rows[0].id, read_at: updated.rows[0].read_at });
});

inboxRoutes.post('/projects/:projectId/inbox/mentions/read-all', async (c) => {
	const teamId = c.get('teamId') as string;
	const auth = c.get('auth');
	if (auth.type !== AuthType.Admin) {
		return err(c, 'FORBIDDEN', 'Only the admin have an inbox', 403);
	}

	const db = c.get('db');
	const updated = await db.query<{ id: string }>(
		`UPDATE admin_mentions
		 SET read_at = now()
		 WHERE team_id = $1 AND user_id = $2 AND read_at IS NULL
		 RETURNING id`,
		[teamId, auth.userId],
	);

	broadcastChange(c, wsRoom.team(teamId), 'admin_mentions', 'UPDATE', {
		team_id: teamId,
		user_id: auth.userId,
		bulk: true,
	});

	return ok(c, { marked_read: updated.rows.length });
});

const NEEDS_YOU_LIMIT = 10;

/**
 * Aggregated "needs you" action items for the dashboard widget: pending
 * approvals + unread admin-inbox rows (an `@admin` mention or an actionable
 * comment like a credential request), sorted by created_at desc, capped at 10
 * items. Also returns a separate per-dashboard action count.
 *
 * This is exactly the project inbox's *unread* set - the widget's "Open inbox"
 * link has to land on the very rows it just listed, and reading one there drops
 * it from the dashboard while the inbox keeps it under Read. A surface the
 * inbox cannot render must not be listed or counted here.
 * `inbox-parity.test.ts` holds the two endpoints together.
 */
inboxRoutes.get('/projects/:projectId/inbox/needs-you', async (c) => {
	const teamId = c.get('teamId') as string;
	const projectId = c.get('projectId') as string;
	const auth = c.get('auth');
	if (auth.type !== AuthType.Admin) {
		return ok(c, { items: [], action_count: 0 });
	}

	const db = c.get('db');
	const adminUserId = auth.userId;

	const [approvals, mentions, countRow] = await Promise.all([
		db.query<{
			id: string;
			type: string;
			created_at: string;
			requested_by_name: string | null;
			payload_task_identifier: string | null;
		}>(
			`SELECT a.id, a.type, a.created_at,
			        ${agentDisplayNameSql('ma', 'm')} AS requested_by_name,
			        pi.identifier AS payload_task_identifier
			 FROM approvals a
			 LEFT JOIN members m ON m.id = a.requested_by_member_id
			 LEFT JOIN member_agents ma ON ma.id = a.requested_by_member_id
			 LEFT JOIN tasks pi ON pi.id = (a.payload->>'task_id')::uuid
			 WHERE a.team_id = $1
			   AND a.status = $2::approval_status
			   AND a.archived_at IS NULL
			   AND (
			     (a.payload->>'project_id')::uuid = $3
			     OR pi.project_id = $3
			     OR (a.payload->>'project_id' IS NULL AND a.payload->>'task_id' IS NULL)
			     OR a.type = $5::approval_type
			   )
			 ORDER BY a.created_at DESC
			 LIMIT $4`,
			[teamId, ApprovalStatus.Pending, projectId, NEEDS_YOU_LIMIT, ApprovalType.Hire],
		),
		db.query<{
			id: string;
			task_id: string;
			task_identifier: string;
			task_title: string;
			comment_public_id: string;
			content_type: string;
			content: unknown;
			author_display_name: string | null;
			created_at: string;
		}>(
			`SELECT bm.id, bm.task_id, i.identifier AS task_identifier, i.title AS task_title,
			        tc.public_id AS comment_public_id, tc.content_type, tc.content,
			        ${agentDisplayNameSql('ma', 'm')} AS author_display_name,
			        bm.created_at
			 FROM admin_mentions bm
			 JOIN tasks i ON i.id = bm.task_id
			 JOIN task_comments tc ON tc.id = bm.comment_id
			 LEFT JOIN members m ON m.id = tc.author_member_id
			 LEFT JOIN member_agents ma ON ma.id = tc.author_member_id
			 WHERE bm.team_id = $1 AND bm.user_id = $2
			   AND i.project_id = $3
			   AND bm.read_at IS NULL AND bm.archived_at IS NULL
			 ORDER BY bm.created_at DESC
			 LIMIT $4`,
			[teamId, adminUserId, projectId, NEEDS_YOU_LIMIT],
		),
		db.query<{ action_count: number }>(
			`SELECT (
			          (SELECT count(*) FROM admin_mentions bm
			           JOIN tasks i ON i.id = bm.task_id
			           WHERE bm.team_id = $1 AND bm.user_id = $2
			             AND i.project_id = $3
			             AND bm.read_at IS NULL AND bm.archived_at IS NULL)
			        + (SELECT count(*) FROM approvals a
			           LEFT JOIN tasks pi ON pi.id = (a.payload->>'task_id')::uuid
			           WHERE a.team_id = $1
			             AND a.status = $4::approval_status
			             AND a.archived_at IS NULL
			             AND (
			               (a.payload->>'project_id')::uuid = $3
			               OR pi.project_id = $3
			               OR (a.payload->>'project_id' IS NULL AND a.payload->>'task_id' IS NULL)
			               OR a.type = $5::approval_type
			             ))
			        )::int AS action_count`,
			[teamId, adminUserId, projectId, ApprovalStatus.Pending, ApprovalType.Hire],
		),
	]);

	type NeedsYouItem =
		| { kind: 'approval'; created_at: string; approval: (typeof approvals.rows)[number] }
		| {
				kind: 'mention';
				created_at: string;
				mention: {
					id: string;
					task_id: string;
					task_identifier: string;
					task_title: string;
					comment_public_id: string;
					content_type: string;
					credential_name: string | null;
					snippet: string;
					author_display_name: string;
					created_at: string;
				};
		  };

	const items: NeedsYouItem[] = [
		...approvals.rows.map((a) => ({
			kind: 'approval' as const,
			created_at: a.created_at,
			approval: a,
		})),
		...mentions.rows.map((m) => ({
			kind: 'mention' as const,
			created_at: m.created_at,
			mention: {
				id: m.id,
				task_id: m.task_id,
				task_identifier: m.task_identifier,
				task_title: m.task_title,
				comment_public_id: m.comment_public_id,
				content_type: m.content_type,
				credential_name: credentialName(m.content_type, m.content),
				snippet: buildSnippet(m.content),
				author_display_name: m.author_display_name ?? 'Agent',
				created_at: m.created_at,
			},
		})),
	]
		.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
		.slice(0, NEEDS_YOU_LIMIT);

	return ok(c, { items, action_count: countRow.rows[0]?.action_count ?? 0 });
});
