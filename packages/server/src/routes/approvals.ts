import {
	ApprovalStatus,
	ApprovalType,
	AuthType,
	summaryPreviewLine,
	validateCadenceChoice,
	wsRoom,
} from '@hezo/shared';
import { Hono } from 'hono';
import type { Db } from '../db/database';
import { agentDisplayNameSql } from '../lib/agent-identity';
import { broadcastChange } from '../lib/broadcast';
import { signAuthorIconUrl } from '../lib/entity-icon-urls';
import { actingPersonFromAuth, resolveAgentId } from '../lib/resolve';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { requireTeamAccessForResource } from '../middleware/auth';
import { type ResolveApprovalError, resolveApproval } from '../services/approval-resolve';
import { heartbeatIntervalFloorMin } from '../services/heartbeat-schedule';
import {
	type HirePayloadPatchInput,
	type HireProposalInput,
	prepareHirePayloadPatch,
	prepareHireProposal,
} from '../services/hire-proposal';
import { authoredPromptError } from '../services/prompt-style-guard';
import {
	broadcastTaskSuggestionCards,
	refreshTaskSuggestionComment,
} from '../services/task-suggestion';
import type { WebSocketManager } from '../services/ws';

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
            ${agentDisplayNameSql('ma', 'm')} AS requested_by_name,
            a.requested_by_member_id,
            ma.slug AS requested_by_slug,
            mu.user_id AS requested_by_user_id,
            (SELECT ui.updated_at FROM user_icons ui WHERE ui.user_id = mu.user_id)
              AS requested_by_user_icon_updated_at,
            ma.avatar_spec AS requested_by_avatar_spec,
            ${agentDisplayNameSql('pma', 'pm')} AS payload_member_name,
            pma.slug AS payload_member_slug,
            pp.name AS payload_project_name,
            pp.slug AS payload_project_slug,
            pi.identifier AS payload_task_identifier,
            tp.slug AS payload_task_project_slug,
            prc.public_id AS payload_run_comment_public_id
     FROM approvals a
     JOIN teams co ON co.id = a.team_id
     LEFT JOIN members m ON m.id = a.requested_by_member_id
     LEFT JOIN member_agents ma ON ma.id = a.requested_by_member_id
     LEFT JOIN member_users mu ON mu.id = a.requested_by_member_id
     LEFT JOIN members pm ON pm.id = (a.payload->>'member_id')::uuid
     LEFT JOIN member_agents pma ON pma.id = pm.id
     LEFT JOIN projects pp ON pp.id = (a.payload->>'project_id')::uuid
     LEFT JOIN tasks pi ON pi.id = (a.payload->>'task_id')::uuid
     -- The task's own project, because a route param resolves against
     -- projects.slug and a team's slug is a different, independently assigned
     -- string. payload_project_slug stays as it is: the OAuth and hire
     -- destinations read it, and widening it would silently redirect them.
     LEFT JOIN projects tp ON tp.id = pi.project_id
     -- The run's entry in the task thread, so a notice can link to the run that
     -- failed rather than the top of the task. Anchored on the indexed task_id;
     -- the JSON predicate filters within one task's comments, which is why this
     -- needs no index of its own.
     LEFT JOIN task_comments prc ON prc.task_id = pi.id
       AND prc.content_type = 'run'
       AND prc.content->>'run_id' = a.payload->>'run_id'
     WHERE a.team_id = $1 AND a.status IN (${statusFilter
				.split(',')
				.map((_, i) => `$${i + 2}::approval_status`)
				.join(', ')})${archivedClause}
     ORDER BY a.created_at DESC`,
		[teamId, ...statusFilter.split(',').map((s) => s.trim())],
	);

	// A human requester's uploaded avatar, so the inbox can put a face on the row.
	// An agent ships its `avatar_spec` instead and is drawn client-side; the
	// built-in CEO/Coach portraits are resolved client-side from the slug.
	const masterKeyManager = c.get('masterKeyManager');
	for (const row of result.rows) {
		row.requested_by_icon_url = await signAuthorIconUrl(masterKeyManager, {
			userId: row.requested_by_user_id,
			userIconUpdatedAt: row.requested_by_user_icon_updated_at,
		});
		delete row.requested_by_user_id;
		delete row.requested_by_user_icon_updated_at;
	}

	return ok(c, result.rows);
});

/** Chars of the previous comment scanned for a blocked task's preview line. */
const BLOCKED_SNIPPET_SCAN_LIMIT = 4000;
const BLOCKED_SNIPPET_MAX_LEN = 120;

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
			   ${agentDisplayNameSql('ma', 'm')} AS agent_name,
			   ma.slug AS agent_slug,
			   (
			     SELECT LEFT(prev.content->>'text', ${BLOCKED_SNIPPET_SCAN_LIMIT})
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
		snippet:
			summaryPreviewLine(r.snippet ?? '', BLOCKED_SNIPPET_MAX_LEN) ||
			'Needs a designated GitHub repo to start work',
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
	// A task suggestion becomes a task on approval, and only `suggest_task` checks
	// the project and task it names.
	if (body.type === ApprovalType.TaskSuggestion) {
		return err(
			c,
			'INVALID_REQUEST',
			'Task suggestions are filed by the CEO with suggest_task',
			400,
		);
	}

	// A hire payload becomes an agent on approval, so it passes the checks every
	// other hire path runs and is stored in their normalized form.
	let payload = body.payload;
	if (body.type === ApprovalType.Hire) {
		const prepared = await prepareHireProposal(
			db,
			teamId,
			body.payload as unknown as HireProposalInput,
		);
		if ('error' in prepared) {
			return err(
				c,
				prepared.conflict ? 'CONFLICT' : 'INVALID_REQUEST',
				prepared.error,
				prepared.conflict ? 409 : 400,
			);
		}
		payload = { ...body.payload, ...prepared.payload };
	}

	const result = await db.query(
		`INSERT INTO approvals (team_id, type, requested_by_member_id, payload)
     VALUES ($1, $2::approval_type, $3, $4::jsonb)
     RETURNING *`,
		[teamId, body.type, body.requested_by_member_id, JSON.stringify(payload)],
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

type PayloadPatch = { error: string } | { patch: Record<string, unknown> };

/**
 * The pending approvals a person may edit before deciding, by type: how to turn
 * the request body into a payload patch, and what else to refresh once it lands.
 */
const PAYLOAD_EDITORS: Partial<
	Record<
		ApprovalType,
		{
			prepare: (
				db: Db,
				teamId: string,
				payload: Record<string, unknown>,
				body: unknown,
			) => Promise<PayloadPatch>;
			/**
			 * Writes in the same transaction as the payload update, and returns what
			 * to announce once that transaction commits.
			 */
			afterUpdate?: (
				db: Db,
				row: Record<string, unknown>,
			) => Promise<(wsManager: WebSocketManager | undefined) => void>;
		}
	>
> = {
	[ApprovalType.Hire]: {
		prepare: (db, teamId, payload, body) =>
			prepareHirePayloadPatch(db, teamId, payload, body as HirePayloadPatchInput),
	},
	[ApprovalType.TaskSuggestion]: {
		// Only the cadence changes, and only on a card the CEO gave a cadence.
		prepare: async (_db, _teamId, payload, body) => {
			const cadence = (body as { cadence?: unknown } | null)?.cadence;
			const error = validateCadenceChoice(payload.suggested_cadence as string | null, cadence);
			return error ? { error } : { patch: { cadence } };
		},
		afterUpdate: async (db, row) => {
			const cards = await refreshTaskSuggestionComment(db, row);
			return (wsManager) => broadcastTaskSuggestionCards(wsManager, row, cards);
		},
	},
};

approvalsRoutes.patch('/approvals/:approvalId', async (c) => {
	const db = c.get('db');
	const approvalId = c.req.param('approvalId');

	const existing = await db.query<{
		status: string;
		team_id: string;
		type: string;
		payload: Record<string, unknown>;
	}>('SELECT status, team_id, type, payload FROM approvals WHERE id = $1', [approvalId]);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Approval not found', 404);
	}
	const approval = existing.rows[0];

	const resourceAccess = await requireTeamAccessForResource(db, c, approval.team_id);
	if (resourceAccess instanceof Response) return resourceAccess;

	const editor = PAYLOAD_EDITORS[approval.type as ApprovalType];
	if (!editor) {
		return err(c, 'INVALID_REQUEST', 'Only hire proposals and task suggestions can be edited', 400);
	}
	if (approval.status !== ApprovalStatus.Pending) {
		return err(c, 'INVALID_STATE', 'Approval is already resolved', 409);
	}

	const body = await c.req.json<unknown>();
	const prepared = await editor.prepare(db, approval.team_id, approval.payload, body);
	if ('error' in prepared) return err(c, 'INVALID_REQUEST', prepared.error, 400);
	const { patch } = prepared;

	// Only a still-pending row takes the edit: one decided since the read above
	// keeps the payload it was decided on. An edit that changes nothing writes
	// nothing. The payload and whatever mirrors it change together.
	const updated = await db.transaction(async () => {
		const result = await db.query<Record<string, unknown>>(
			`UPDATE approvals SET payload = payload || $1::jsonb
			 WHERE id = $2 AND status = $3::approval_status AND NOT (payload @> $1::jsonb)
			 RETURNING *`,
			[JSON.stringify(patch), approvalId, ApprovalStatus.Pending],
		);
		const changed = result.rows[0];
		if (!changed) return null;
		return { row: changed, announce: await editor.afterUpdate?.(db, changed) };
	});
	if (!updated) {
		const current = await db.query<Record<string, unknown>>(
			'SELECT * FROM approvals WHERE id = $1',
			[approvalId],
		);
		if (current.rows[0]?.status !== ApprovalStatus.Pending) {
			return err(c, 'INVALID_STATE', 'Approval is already resolved', 409);
		}
		return ok(c, current.rows[0]);
	}
	const { row, announce } = updated;
	announce?.(c.get('wsManager'));
	broadcastChange(c, wsRoom.team(approval.team_id), 'approvals', 'UPDATE', row);
	return ok(c, row);
});

/** How each way a decision can fail reaches the client. */
const RESOLVE_ERROR_RESPONSE: Record<ResolveApprovalError, [string, 404 | 409]> = {
	NOT_FOUND: ['NOT_FOUND', 404],
	INVALID_STATE: ['INVALID_STATE', 409],
	// The side effect could not be applied; the approval is pending again.
	SIDE_EFFECT_FAILED: ['CONFLICT', 409],
};

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
	if (auth.type === AuthType.Admin) {
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
		decider: actingPersonFromAuth(auth),
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
			egressProxy: c.get('egressProxy'),
			egressCAPath: c.get('egressProxy')?.caCertPath ?? null,
		},
	});

	if (!resolved.ok) {
		const [code, status] = RESOLVE_ERROR_RESPONSE[resolved.error];
		return err(c, code, resolved.message, status);
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
