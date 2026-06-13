import {
	AgentAdminStatus,
	AgentRuntimeStatus,
	ApprovalType,
	AuthType,
	TaskPriority,
	TERMINAL_TASK_STATUSES,
} from '@hezo/shared';
import { Hono } from 'hono';
import { resolveTaskId } from '../lib/resolve';
import { err, ok } from '../lib/response';
import { terminalStatusParams } from '../lib/sql';
import type { Env } from '../lib/types';
import { broadcastApprovalChange } from '../services/approval-broadcast';
import { getAgentBudgetStatus } from '../services/budget';
import { fireCommentWakeups } from '../services/comment-wakeups';

export const agentApiRoutes = new Hono<Env>();

agentApiRoutes.post('/heartbeat', async (c) => {
	const db = c.get('db');
	const auth = c.get('auth');

	if (auth.type !== AuthType.Agent) {
		return err(c, 'UNAUTHORIZED', 'Agent token required', 401);
	}

	const { memberId, teamId } = auth;

	await db.query('UPDATE member_agents SET last_heartbeat_at = now() WHERE id = $1', [memberId]);

	const agent = await db.query<{
		id: string;
		title: string;
		runtime_status: string;
		admin_status: string;
		monthly_budget_cents: number;
	}>(
		`SELECT ma.id, ma.title, ma.runtime_status, ma.admin_status, ma.monthly_budget_cents
		 FROM member_agents ma
		 WHERE ma.id = $1`,
		[memberId],
	);

	if (agent.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Agent not found', 404);
	}

	const agentRow = agent.rows[0];
	// Remaining monthly budget is derived from cost_entries (no running counter);
	// 0 limit means unlimited, surfaced as null remaining.
	const monthlyStatus = await getAgentBudgetStatus(db, memberId);
	const budgetRemaining =
		agentRow.monthly_budget_cents > 0
			? agentRow.monthly_budget_cents - monthlyStatus.monthly.spentCents
			: null;

	if (
		agentRow.admin_status === AgentAdminStatus.Disabled ||
		agentRow.runtime_status === AgentRuntimeStatus.Paused
	) {
		return ok(c, {
			agent: {
				id: agentRow.id,
				title: agentRow.title,
				runtime_status: agentRow.runtime_status,
				admin_status: agentRow.admin_status,
				budget_remaining_cents: budgetRemaining,
			},
			assigned_tasks: [],
			notifications: [],
		});
	}

	const ts = terminalStatusParams(3, false);
	const terminalPlaceholders = ts.placeholders;

	const tasks = await db.query(
		`SELECT i.id, i.number, i.identifier, i.title, i.description, i.status, i.priority,
		        p.name AS project_name, p.description AS project_description, p.id AS project_id,
		        co.description AS team_description,
		        (SELECT count(*)::int FROM task_comments ic
		         WHERE ic.task_id = i.id AND ic.created_at > COALESCE(
		           (SELECT MAX(ic2.created_at) FROM task_comments ic2
		            WHERE ic2.task_id = i.id AND ic2.author_member_id = $1), '1970-01-01'
		         ) AND ic.author_member_id != $1) AS unread_comments
		 FROM tasks i
		 JOIN projects p ON p.id = i.project_id
		 JOIN teams co ON co.id = i.team_id
		 WHERE i.assignee_id = $1 AND i.team_id = $2
		   AND i.status NOT IN (${terminalPlaceholders})
		 ORDER BY
		   CASE i.priority
		     WHEN ${`$${TERMINAL_TASK_STATUSES.length + 3}`} THEN 0
		     WHEN ${`$${TERMINAL_TASK_STATUSES.length + 4}`} THEN 1
		     WHEN ${`$${TERMINAL_TASK_STATUSES.length + 5}`} THEN 2
		     WHEN ${`$${TERMINAL_TASK_STATUSES.length + 6}`} THEN 3
		   END,
		   i.created_at ASC`,
		[
			memberId,
			teamId,
			...TERMINAL_TASK_STATUSES,
			TaskPriority.Urgent,
			TaskPriority.High,
			TaskPriority.Medium,
			TaskPriority.Low,
		],
	);

	const notifications = await db.query<{
		id: string;
		task_id: string;
		task_number: number;
		task_identifier: string;
	}>(
		`SELECT ic.id, ic.task_id, i.number AS task_number, i.identifier AS task_identifier,
		        ic.content, ic.author_member_id
		 FROM task_comments ic
		 JOIN tasks i ON i.id = ic.task_id
		 WHERE ic.content::text LIKE $1
		   AND i.team_id = $2
		   AND ic.created_at > COALESCE(
		     (SELECT last_heartbeat_at FROM member_agents WHERE id = $3),
		     now() - interval '1 hour'
		   )
		   AND ic.author_member_id != $3
		 ORDER BY ic.created_at DESC
		 LIMIT 20`,
		[`%@${agentRow.title.toLowerCase().replace(/\s+/g, '-')}%`, teamId, memberId],
	);

	return ok(c, {
		agent: {
			id: agentRow.id,
			member_id: memberId,
			title: agentRow.title,
			runtime_status: agentRow.runtime_status,
			admin_status: agentRow.admin_status,
			budget_remaining_cents: budgetRemaining,
		},
		assigned_tasks: tasks.rows,
		notifications: notifications.rows.map((n) => ({
			type: 'mention',
			task_id: n.task_id,
			task_number: n.task_number,
			task_identifier: n.task_identifier,
			comment_id: n.id,
		})),
	});
});

agentApiRoutes.post('/tasks/:taskId/comments', async (c) => {
	const db = c.get('db');
	const auth = c.get('auth');

	if (auth.type !== AuthType.Agent) {
		return err(c, 'UNAUTHORIZED', 'Agent token required', 401);
	}

	const taskId = await resolveTaskId(db, auth.teamId, c.req.param('taskId'));
	if (!taskId) return err(c, 'NOT_FOUND', 'Task not found', 404);

	const body = await c.req.json<{
		content_type: string;
		content: Record<string, unknown>;
		parent_comment_id?: string | null;
	}>();

	if (!body.content_type || !body.content) {
		return err(c, 'INVALID_REQUEST', 'content_type and content are required', 400);
	}

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

	const result = await db.query<{ id: string }>(
		`INSERT INTO task_comments (task_id, author_member_id, parent_comment_id, content_type, content)
		 VALUES ($1, $2, $3, $4::comment_content_type, $5::jsonb)
		 RETURNING *`,
		[taskId, auth.memberId, parentCommentId, body.content_type, JSON.stringify(body.content)],
	);

	await fireCommentWakeups({
		db,
		taskId,
		teamId: auth.teamId,
		commentId: result.rows[0].id,
		content: body.content,
		contentType: body.content_type,
		authorMemberId: auth.memberId,
		authorRunId: auth.runId,
		parentCommentId,
		wsManager: c.get('wsManager'),
	});

	return ok(c, result.rows[0], 201);
});

agentApiRoutes.post('/tasks/:taskId/comments/:commentId/tool-calls', async (c) => {
	const db = c.get('db');
	const auth = c.get('auth');

	if (auth.type !== AuthType.Agent) {
		return err(c, 'UNAUTHORIZED', 'Agent token required', 401);
	}

	const taskId = await resolveTaskId(db, auth.teamId, c.req.param('taskId'));
	if (!taskId) return err(c, 'NOT_FOUND', 'Task not found', 404);
	const commentId = c.req.param('commentId');

	const commentCheck = await db.query(
		'SELECT id FROM task_comments WHERE id = $1 AND task_id = $2',
		[commentId, taskId],
	);
	if (commentCheck.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Comment not found', 404);
	}

	const body = await c.req.json<{
		tool_calls: Array<{
			tool_name: string;
			input?: unknown;
			output?: unknown;
			status: string;
			duration_ms?: number;
			cost_cents?: number;
		}>;
	}>();

	if (!body.tool_calls?.length) {
		return err(c, 'INVALID_REQUEST', 'tool_calls array is required', 400);
	}

	const results = [];
	for (const tc of body.tool_calls) {
		const result = await db.query(
			`INSERT INTO tool_calls (comment_id, member_id, tool_name, input, output, status, duration_ms, cost_cents)
			 VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::tool_call_status, $7, $8)
			 RETURNING *`,
			[
				commentId,
				auth.memberId,
				tc.tool_name,
				JSON.stringify(tc.input ?? {}),
				JSON.stringify(tc.output ?? {}),
				tc.status,
				tc.duration_ms ?? 0,
				tc.cost_cents ?? 0,
			],
		);
		results.push(result.rows[0]);
		// tool_calls.cost_cents is retained for display only. Budget spend is recorded
		// once per run at completion (services/agent-runner.ts → recordRunCost) — the
		// run total already includes tool-call cost, so debiting here would double-count.
	}

	return ok(c, results, 201);
});

agentApiRoutes.post('/secrets/request', async (c) => {
	const db = c.get('db');
	const auth = c.get('auth');

	if (auth.type !== AuthType.Agent) {
		return err(c, 'UNAUTHORIZED', 'Agent token required', 401);
	}

	const body = await c.req.json<{
		secret_name: string;
		project_id?: string;
		reason: string;
	}>();

	if (!body.secret_name || !body.reason) {
		return err(c, 'INVALID_REQUEST', 'secret_name and reason are required', 400);
	}

	const result = await db.query<Record<string, unknown>>(
		`INSERT INTO approvals (team_id, type, payload)
		 VALUES ($1, $2::approval_type, $3::jsonb)
		 RETURNING *`,
		[
			auth.teamId,
			ApprovalType.SecretAccess,
			JSON.stringify({
				member_id: auth.memberId,
				secret_name: body.secret_name,
				project_id: body.project_id,
				reason: body.reason,
			}),
		],
	);
	const row = result.rows[0];
	if (row) {
		broadcastApprovalChange(c.get('wsManager'), auth.teamId, 'INSERT', row);
	}

	return ok(c, { approval_id: row?.id, status: row?.status }, 201);
});

agentApiRoutes.get('/secrets/mine', async (c) => {
	const db = c.get('db');
	const auth = c.get('auth');

	if (auth.type !== AuthType.Agent) {
		return err(c, 'UNAUTHORIZED', 'Agent token required', 401);
	}

	// Secrets are instance-global; surface the user-facing credential names an
	// agent may emit as placeholders. OAuth tokens (OAUTH_*) and the internal
	// ssh signing key are injected by the runtime, not hinted here.
	const result = await db.query(
		`SELECT name, category
		 FROM secrets
		 WHERE name NOT LIKE 'OAUTH\\_%' AND name <> 'ssh_private_key'
		 ORDER BY name ASC`,
	);

	return ok(c, result.rows);
});
