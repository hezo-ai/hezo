import { ApprovalStatus, ApprovalType, AuthType, wsRoom } from '@hezo/shared';
import { Hono } from 'hono';
import { broadcastChange } from '../lib/broadcast';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { requireTeamAccessForResource } from '../middleware/auth';
import { resolveApproval } from '../services/approval-resolve';
import { buildHirePayloadPatch, type HirePayloadPatchInput } from '../services/hire-proposal';

export const approvalsRoutes = new Hono<Env>();

approvalsRoutes.get('/projects/:projectId/approvals', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const statusFilter = c.req.query('status') || ApprovalStatus.Pending;
	const archivedParam = c.req.query('archived');
	const archivedClause =
		archivedParam === 'true'
			? ' AND a.archived_at IS NOT NULL'
			: archivedParam === 'false'
				? ' AND a.archived_at IS NULL'
				: '';

	const result = await db.query(
		`SELECT a.id, a.team_id, a.type, a.status, a.payload, a.resolution_note,
            a.resolved_at, a.archived_at, a.created_at,
            co.name AS team_name,
            co.slug AS team_slug,
            COALESCE(ma.title, m.display_name) AS requested_by_name,
            a.requested_by_member_id,
            COALESCE(pma.title, pm.display_name) AS payload_member_name,
            pma.slug AS payload_member_slug,
            pp.name AS payload_project_name,
            pp.slug AS payload_project_slug,
            pi.identifier AS payload_task_identifier
     FROM approvals a
     JOIN teams co ON co.id = a.team_id
     LEFT JOIN members m ON m.id = a.requested_by_member_id
     LEFT JOIN member_agents ma ON ma.id = a.requested_by_member_id
     LEFT JOIN members pm ON pm.id = (a.payload->>'member_id')::uuid
     LEFT JOIN member_agents pma ON pma.id = pm.id
     LEFT JOIN projects pp ON pp.id = (a.payload->>'project_id')::uuid
     LEFT JOIN tasks pi ON pi.id = (a.payload->>'task_id')::uuid
     WHERE a.team_id = $1 AND a.status IN (${statusFilter
				.split(',')
				.map((_, i) => `$${i + 2}::approval_status`)
				.join(', ')})${archivedClause}
     ORDER BY a.created_at DESC`,
		[teamId, ...statusFilter.split(',').map((s) => s.trim())],
	);

	return ok(c, result.rows);
});

approvalsRoutes.get('/projects/:projectId/approvals/:approvalId/blocked-tickets', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const approvalId = c.req.param('approvalId');

	const approval = await db.query<{ id: string; type: string }>(
		'SELECT id, type FROM approvals WHERE id = $1 AND team_id = $2',
		[approvalId, teamId],
	);
	if (approval.rows.length === 0) return err(c, 'NOT_FOUND', 'Approval not found', 404);
	if (approval.rows[0].type !== ApprovalType.DesignatedRepoRequest) {
		return err(
			c,
			'INVALID_REQUEST',
			'blocked-tickets only applies to designated_repo_request approvals',
			400,
		);
	}

	const rows = await db.query<{
		task_id: string;
		identifier: string;
		title: string;
		project_slug: string;
		comment_id: string;
		comment_public_id: string;
		comment_created_at: string;
		agent_name: string | null;
		agent_slug: string | null;
		snippet: string | null;
	}>(
		`SELECT
			   i.id AS task_id,
			   i.identifier,
			   i.title,
			   p.slug AS project_slug,
			   ic.id AS comment_id,
			   ic.public_id AS comment_public_id,
			   ic.created_at AS comment_created_at,
			   COALESCE(ma.title, m.display_name) AS agent_name,
			   ma.slug AS agent_slug,
			   (
			     SELECT LEFT(prev.content->>'text', 120)
			     FROM task_comments prev
			     WHERE prev.task_id = i.id
			       AND prev.content_type IN ('text'::comment_content_type, 'system'::comment_content_type)
			       AND prev.content->>'text' IS NOT NULL
			       AND prev.created_at < ic.created_at
			     ORDER BY prev.created_at DESC
			     LIMIT 1
			   ) AS snippet
			 FROM task_comments ic
			 JOIN tasks i ON i.id = ic.task_id
			 JOIN projects p ON p.id = i.project_id
			 LEFT JOIN members m ON m.id = i.assignee_id
			 LEFT JOIN member_agents ma ON ma.id = m.id
			 WHERE ic.content_type = 'action'::comment_content_type
			   AND ic.content->>'kind' = 'setup_repo'
			   AND ic.content->>'approval_id' = $1
			   AND ic.chosen_option IS NULL
			   AND i.team_id = $2
			 ORDER BY i.identifier ASC`,
		[approvalId, teamId],
	);

	const tickets = rows.rows.map((r) => ({
		task_id: r.task_id,
		identifier: r.identifier,
		title: r.title,
		project_slug: r.project_slug,
		comment_id: r.comment_id,
		comment_public_id: r.comment_public_id,
		comment_created_at: r.comment_created_at,
		agent_name: r.agent_name,
		agent_slug: r.agent_slug,
		snippet: r.snippet?.trim() || 'Needs a designated GitHub repo to start work',
	}));

	return ok(c, tickets);
});

approvalsRoutes.post('/projects/:projectId/approvals', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');

	const body = await c.req.json<{
		type: string;
		requested_by_member_id: string;
		payload: Record<string, unknown>;
	}>();

	if (!body.type || !body.payload) {
		return err(c, 'INVALID_REQUEST', 'type and payload are required', 400);
	}

	const result = await db.query(
		`INSERT INTO approvals (team_id, type, requested_by_member_id, payload)
     VALUES ($1, $2::approval_type, $3, $4::jsonb)
     RETURNING *`,
		[teamId, body.type, body.requested_by_member_id, JSON.stringify(body.payload)],
	);

	broadcastChange(
		c,
		wsRoom.team(teamId),
		'approvals',
		'INSERT',
		result.rows[0] as Record<string, unknown>,
	);
	return ok(c, result.rows[0], 201);
});

approvalsRoutes.patch('/approvals/:approvalId', async (c) => {
	const db = c.get('db');
	const approvalId = c.req.param('approvalId');

	const existing = await db.query<{ status: string; team_id: string; type: string }>(
		'SELECT status, team_id, type FROM approvals WHERE id = $1',
		[approvalId],
	);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Approval not found', 404);
	}
	const approval = existing.rows[0];

	const resourceAccess = await requireTeamAccessForResource(db, c, approval.team_id);
	if (resourceAccess instanceof Response) return resourceAccess;

	if (approval.type !== ApprovalType.Hire) {
		return err(c, 'INVALID_REQUEST', 'Only hire proposals can be edited', 400);
	}
	if (approval.status !== ApprovalStatus.Pending) {
		return err(c, 'INVALID_STATE', 'Approval is already resolved', 409);
	}

	const body = await c.req.json<HirePayloadPatchInput>();
	const patch = buildHirePayloadPatch(body);
	if (Object.keys(patch).length === 0) {
		return err(c, 'INVALID_REQUEST', 'No fields to update', 400);
	}

	const updated = await db.query<Record<string, unknown>>(
		`UPDATE approvals SET payload = payload || $1::jsonb WHERE id = $2 RETURNING *`,
		[JSON.stringify(patch), approvalId],
	);
	const row = updated.rows[0];
	broadcastChange(c, wsRoom.team(approval.team_id), 'approvals', 'UPDATE', row);
	return ok(c, row);
});

approvalsRoutes.post('/approvals/:approvalId/resolve', async (c) => {
	const db = c.get('db');
	const approvalId = c.req.param('approvalId');

	const existing = await db.query<{ status: string; team_id: string }>(
		'SELECT status, team_id FROM approvals WHERE id = $1',
		[approvalId],
	);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Approval not found', 404);
	}

	const resourceAccess = await requireTeamAccessForResource(db, c, existing.rows[0].team_id);
	if (resourceAccess instanceof Response) return resourceAccess;

	if (existing.rows[0].status !== ApprovalStatus.Pending) {
		return err(c, 'INVALID_STATE', 'Approval is already resolved', 409);
	}

	const body = await c.req.json<{
		status: 'approved' | 'denied';
		resolution_note?: string;
	}>();

	if (body.status !== ApprovalStatus.Approved && body.status !== ApprovalStatus.Denied) {
		return err(c, 'INVALID_REQUEST', "status must be 'approved' or 'denied'", 400);
	}

	const auth = c.get('auth');
	let actorMemberId: string | null = null;
	if (auth.type === AuthType.Agent) {
		actorMemberId = auth.memberId;
	} else if (auth.type === AuthType.Admin) {
		const r = await db.query<{ id: string }>(
			`SELECT m.id FROM members m
			   JOIN member_users mu ON mu.id = m.id
			  WHERE mu.user_id = $1 AND m.team_id = $2`,
			[auth.userId, existing.rows[0].team_id],
		);
		actorMemberId = r.rows[0]?.id ?? null;
	}

	const resolved = await resolveApproval(db, approvalId, {
		status: body.status,
		resolutionNote: body.resolution_note ?? null,
		dataDir: c.get('dataDir'),
		actorMemberId,
		wsManager: c.get('wsManager'),
		events: c.get('events'),
		containerDeps: {
			db,
			docker: c.get('docker'),
			dataDir: c.get('dataDir'),
			wsManager: c.get('wsManager'),
			masterKeyManager: c.get('masterKeyManager'),
			logs: c.get('logs'),
			containerLogStreamer: c.get('containerLogStreamer'),
			sshAgentServer: c.get('sshAgentServer'),
			egressCAPath: c.get('egressProxy')?.caCertPath ?? null,
		},
	});

	if (!resolved.ok) {
		if (resolved.error === 'NOT_FOUND') {
			return err(c, 'NOT_FOUND', resolved.message, 404);
		}
		return err(c, 'INVALID_STATE', resolved.message, 409);
	}

	const { row, sideEffects } = resolved;
	if (row.team_id) {
		const room = wsRoom.team(row.team_id as string);
		broadcastChange(c, room, 'approvals', 'UPDATE', row);
		for (const effect of sideEffects) {
			broadcastChange(c, room, effect.table, effect.op, effect.row);
		}
	}
	return ok(c, row);
});
