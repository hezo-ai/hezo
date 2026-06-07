import { ApprovalStatus, AuthType, wsRoom } from '@hezo/shared';
import { Hono } from 'hono';
import { broadcastChange } from '../lib/broadcast';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';

export const inboxRoutes = new Hono<Env>();

const SNIPPET_MAX_LEN = 180;

function buildSnippet(content: unknown): string {
	if (!content || typeof content !== 'object') return '';
	const text = (content as Record<string, unknown>).text;
	if (typeof text !== 'string') return '';
	const stripped = text.replace(/\s+/g, ' ').trim();
	if (stripped.length <= SNIPPET_MAX_LEN) return stripped;
	return `${stripped.slice(0, SNIPPET_MAX_LEN - 1).trimEnd()}…`;
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
	content: unknown;
	author_member_id: string | null;
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
		        bm.comment_id, tc.content,
		        tc.author_member_id,
		        COALESCE(ma.title, m.display_name) AS author_display_name,
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

	return ok(
		c,
		result.rows.map((r) => ({
			id: r.id,
			team_id: r.team_id,
			team_slug: r.team_slug,
			task_id: r.task_id,
			task_identifier: r.task_identifier,
			task_title: r.task_title,
			project_slug: r.project_slug,
			comment_id: r.comment_id,
			snippet: buildSnippet(r.content),
			author_member_id: r.author_member_id,
			author_display_name: r.author_display_name ?? 'Admin',
			author_slug: r.author_slug,
			created_at: r.created_at,
			read_at: r.read_at,
		})),
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
		           WHERE team_id = $1 AND user_id = $2 AND read_at IS NULL)
		        + (SELECT count(*) FROM approvals
		           WHERE team_id = $1 AND status = $3::approval_status)
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
