import { AuthType, wsRoom } from '@hezo/shared';
import { Hono } from 'hono';
import { broadcastChange } from '../lib/broadcast';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { requireCompanyAccess } from '../middleware/auth';

export const notificationsRoutes = new Hono<Env>();

interface NotificationRow {
	id: string;
	company_id: string;
	company_slug: string;
	company_name: string;
	recipient_member_user_id: string;
	kind: string;
	payload: Record<string, unknown>;
	read_at: string | null;
	created_at: string;
	issue_id: string | null;
	issue_identifier: string | null;
	issue_title: string | null;
	project_slug: string | null;
	requester_name: string | null;
}

async function resolveCallerMemberUserId(
	c: Parameters<typeof requireCompanyAccess>[0],
	companyId: string,
): Promise<string | null> {
	const auth = c.get('auth');
	if (auth.type !== AuthType.Board) return null;
	const db = c.get('db');
	const r = await db.query<{ id: string }>(
		`SELECT mu.id FROM member_users mu
		   JOIN members m ON m.id = mu.id
		  WHERE mu.user_id = $1 AND m.company_id = $2`,
		[auth.userId, companyId],
	);
	return r.rows[0]?.id ?? null;
}

notificationsRoutes.get('/companies/:companyId/notifications', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const memberUserId = await resolveCallerMemberUserId(c, access.companyId);
	if (!memberUserId) return ok(c, []);

	const db = c.get('db');
	const unreadOnly = c.req.query('unread_only') === 'true';
	const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50), 1), 200);

	const result = await db.query<NotificationRow>(
		`SELECT n.id, n.company_id, n.recipient_member_user_id, n.kind, n.payload,
		        n.read_at, n.created_at,
		        co.slug AS company_slug,
		        co.name AS company_name,
		        i.id AS issue_id,
		        i.identifier AS issue_identifier,
		        i.title AS issue_title,
		        p.slug AS project_slug,
		        COALESCE(ma.title, NULLIF(rm.display_name, ''), 'Board') AS requester_name
		   FROM notifications n
		   JOIN companies co ON co.id = n.company_id
		   LEFT JOIN issues i ON i.id = (n.payload->>'issue_id')::uuid
		   LEFT JOIN projects p ON p.id = i.project_id
		   LEFT JOIN members rm ON rm.id = (n.payload->>'requested_by_member_id')::uuid
		   LEFT JOIN member_agents ma ON ma.id = rm.id
		  WHERE n.recipient_member_user_id = $1
		    ${unreadOnly ? 'AND n.read_at IS NULL' : ''}
		  ORDER BY n.created_at DESC
		  LIMIT ${limit}`,
		[memberUserId],
	);

	return ok(c, result.rows);
});

notificationsRoutes.patch('/companies/:companyId/notifications/:id', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const memberUserId = await resolveCallerMemberUserId(c, access.companyId);
	if (!memberUserId) return err(c, 'FORBIDDEN', 'Notifications are scoped to board members', 403);

	const db = c.get('db');
	const id = c.req.param('id');
	const body = await c.req.json<{ read?: boolean }>();
	if (typeof body.read !== 'boolean') {
		return err(c, 'INVALID_REQUEST', 'read must be boolean', 400);
	}

	const r = await db.query<Record<string, unknown>>(
		`UPDATE notifications
		    SET read_at = $1
		  WHERE id = $2 AND recipient_member_user_id = $3 AND company_id = $4
		  RETURNING *`,
		[body.read ? new Date().toISOString() : null, id, memberUserId, access.companyId],
	);
	if (r.rows.length === 0) return err(c, 'NOT_FOUND', 'Notification not found', 404);

	broadcastChange(c, wsRoom.company(access.companyId), 'notifications', 'UPDATE', r.rows[0]);
	return ok(c, r.rows[0]);
});

notificationsRoutes.post('/companies/:companyId/notifications/mark-all-read', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const memberUserId = await resolveCallerMemberUserId(c, access.companyId);
	if (!memberUserId) return err(c, 'FORBIDDEN', 'Notifications are scoped to board members', 403);

	const db = c.get('db');
	const r = await db.query<Record<string, unknown>>(
		`UPDATE notifications
		    SET read_at = now()
		  WHERE recipient_member_user_id = $1 AND company_id = $2 AND read_at IS NULL
		  RETURNING *`,
		[memberUserId, access.companyId],
	);

	for (const row of r.rows) {
		broadcastChange(c, wsRoom.company(access.companyId), 'notifications', 'UPDATE', row);
	}
	return ok(c, { updated: r.rows.length });
});
