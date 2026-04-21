import {
	AgentAdminStatus,
	AgentRuntimeStatus,
	ApprovalType,
	AuthType,
	IssuePriority,
	TERMINAL_ISSUE_STATUSES,
	wsRoom,
} from '@hezo/shared';
import { Hono } from 'hono';
import { resolveIssueId } from '../lib/resolve';
import { err, ok } from '../lib/response';
import { terminalStatusParams } from '../lib/sql';
import type { Env } from '../lib/types';

export const agentApiRoutes = new Hono<Env>();

agentApiRoutes.post('/heartbeat', async (c) => {
	const db = c.get('db');
	const auth = c.get('auth');

	if (auth.type !== AuthType.Agent) {
		return err(c, 'UNAUTHORIZED', 'Agent token required', 401);
	}

	const { memberId, companyId } = auth;

	await db.query('UPDATE member_agents SET last_heartbeat_at = now() WHERE id = $1', [memberId]);

	const agent = await db.query<{
		id: string;
		title: string;
		runtime_status: string;
		admin_status: string;
		system_prompt: string;
		monthly_budget_cents: number;
		budget_used_cents: number;
	}>(
		`SELECT ma.id, ma.title, ma.runtime_status, ma.admin_status, ma.system_prompt,
		        ma.monthly_budget_cents, ma.budget_used_cents
		 FROM member_agents ma
		 WHERE ma.id = $1`,
		[memberId],
	);

	if (agent.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Agent not found', 404);
	}

	const agentRow = agent.rows[0];
	const budgetRemaining = agentRow.monthly_budget_cents - agentRow.budget_used_cents;

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
			assigned_issues: [],
			notifications: [],
		});
	}

	const ts = terminalStatusParams(3, false);
	const terminalPlaceholders = ts.placeholders;

	const issues = await db.query(
		`SELECT i.id, i.number, i.identifier, i.title, i.description, i.status, i.priority,
		        p.name AS project_name, p.description AS project_description, p.id AS project_id,
		        co.description AS company_description,
		        (SELECT count(*)::int FROM issue_comments ic
		         WHERE ic.issue_id = i.id AND ic.created_at > COALESCE(
		           (SELECT MAX(ic2.created_at) FROM issue_comments ic2
		            WHERE ic2.issue_id = i.id AND ic2.author_member_id = $1), '1970-01-01'
		         ) AND ic.author_member_id != $1) AS unread_comments
		 FROM issues i
		 JOIN projects p ON p.id = i.project_id
		 JOIN companies co ON co.id = i.company_id
		 WHERE i.assignee_id = $1 AND i.company_id = $2
		   AND i.status NOT IN (${terminalPlaceholders})
		 ORDER BY
		   CASE i.priority
		     WHEN ${`$${TERMINAL_ISSUE_STATUSES.length + 3}`} THEN 0
		     WHEN ${`$${TERMINAL_ISSUE_STATUSES.length + 4}`} THEN 1
		     WHEN ${`$${TERMINAL_ISSUE_STATUSES.length + 5}`} THEN 2
		     WHEN ${`$${TERMINAL_ISSUE_STATUSES.length + 6}`} THEN 3
		   END,
		   i.created_at ASC`,
		[
			memberId,
			companyId,
			...TERMINAL_ISSUE_STATUSES,
			IssuePriority.Urgent,
			IssuePriority.High,
			IssuePriority.Medium,
			IssuePriority.Low,
		],
	);

	const notifications = await db.query<{
		id: string;
		issue_id: string;
		issue_number: number;
		issue_identifier: string;
	}>(
		`SELECT ic.id, ic.issue_id, i.number AS issue_number, i.identifier AS issue_identifier,
		        ic.content, ic.author_member_id
		 FROM issue_comments ic
		 JOIN issues i ON i.id = ic.issue_id
		 WHERE ic.content::text LIKE $1
		   AND i.company_id = $2
		   AND ic.created_at > COALESCE(
		     (SELECT last_heartbeat_at FROM member_agents WHERE id = $3),
		     now() - interval '1 hour'
		   )
		   AND ic.author_member_id != $3
		 ORDER BY ic.created_at DESC
		 LIMIT 20`,
		[`%@${agentRow.title.toLowerCase().replace(/\s+/g, '-')}%`, companyId, memberId],
	);

	return ok(c, {
		agent: {
			id: agentRow.id,
			member_id: memberId,
			title: agentRow.title,
			runtime_status: agentRow.runtime_status,
			admin_status: agentRow.admin_status,
			system_prompt: agentRow.system_prompt,
			budget_remaining_cents: budgetRemaining,
		},
		assigned_issues: issues.rows,
		notifications: notifications.rows.map((n) => ({
			type: 'mention',
			issue_id: n.issue_id,
			issue_number: n.issue_number,
			issue_identifier: n.issue_identifier,
			comment_id: n.id,
		})),
	});
});

agentApiRoutes.post('/issues/:issueId/comments', async (c) => {
	const db = c.get('db');
	const auth = c.get('auth');

	if (auth.type !== AuthType.Agent) {
		return err(c, 'UNAUTHORIZED', 'Agent token required', 401);
	}

	const issueId = await resolveIssueId(db, auth.companyId, c.req.param('issueId'));
	if (!issueId) return err(c, 'NOT_FOUND', 'Issue not found', 404);

	const body = await c.req.json<{
		content_type: string;
		content: Record<string, unknown>;
	}>();

	if (!body.content_type || !body.content) {
		return err(c, 'INVALID_REQUEST', 'content_type and content are required', 400);
	}

	const result = await db.query(
		`INSERT INTO issue_comments (issue_id, author_member_id, content_type, content)
		 VALUES ($1, $2, $3::comment_content_type, $4::jsonb)
		 RETURNING *`,
		[issueId, auth.memberId, body.content_type, JSON.stringify(body.content)],
	);

	return ok(c, result.rows[0], 201);
});

agentApiRoutes.post('/issues/:issueId/comments/:commentId/tool-calls', async (c) => {
	const db = c.get('db');
	const auth = c.get('auth');

	if (auth.type !== AuthType.Agent) {
		return err(c, 'UNAUTHORIZED', 'Agent token required', 401);
	}

	const issueId = await resolveIssueId(db, auth.companyId, c.req.param('issueId'));
	if (!issueId) return err(c, 'NOT_FOUND', 'Issue not found', 404);
	const commentId = c.req.param('commentId');

	const commentCheck = await db.query(
		'SELECT id FROM issue_comments WHERE id = $1 AND issue_id = $2',
		[commentId, issueId],
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

		if (tc.cost_cents && tc.cost_cents > 0) {
			const issue = await db.query<{ project_id: string }>(
				'SELECT project_id FROM issues WHERE id = $1',
				[issueId],
			);

			const debitResult = await db.query<{ debit_agent_budget: boolean }>(
				'SELECT debit_agent_budget($1, $2)',
				[auth.memberId, tc.cost_cents],
			);

			await db.query(
				`INSERT INTO cost_entries (company_id, member_id, issue_id, project_id, amount_cents, description)
				 VALUES ($1, $2, $3, $4, $5, $6)`,
				[
					auth.companyId,
					auth.memberId,
					issueId,
					issue.rows[0]?.project_id,
					tc.cost_cents,
					`Tool call: ${tc.tool_name}`,
				],
			);

			if (!debitResult.rows[0]?.debit_agent_budget) {
				await db.query(
					`UPDATE member_agents SET runtime_status = $1::agent_runtime_status WHERE id = $2`,
					[AgentRuntimeStatus.Paused, auth.memberId],
				);
				const wsManager = c.get('wsManager');
				wsManager.broadcast(wsRoom.company(auth.companyId), {
					type: 'row_change',
					table: 'member_agents',
					action: 'UPDATE',
					row: { id: auth.memberId, runtime_status: AgentRuntimeStatus.Paused },
				});
				return c.json(
					{
						error: {
							code: 'BUDGET_EXCEEDED',
							message: 'Agent budget limit reached. Agent has been paused.',
						},
					},
					402,
				);
			}
		}
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

	const result = await db.query<{ id: string; status: string }>(
		`INSERT INTO approvals (company_id, type, payload)
		 VALUES ($1, $2::approval_type, $3::jsonb)
		 RETURNING id, status`,
		[
			auth.companyId,
			ApprovalType.SecretAccess,
			JSON.stringify({
				member_id: auth.memberId,
				secret_name: body.secret_name,
				project_id: body.project_id,
				reason: body.reason,
			}),
		],
	);

	return ok(c, { approval_id: result.rows[0].id, status: result.rows[0].status }, 201);
});

agentApiRoutes.get('/secrets/mine', async (c) => {
	const db = c.get('db');
	const auth = c.get('auth');

	if (auth.type !== AuthType.Agent) {
		return err(c, 'UNAUTHORIZED', 'Agent token required', 401);
	}

	const result = await db.query(
		`SELECT s.name, s.category
		 FROM secret_grants sg
		 JOIN secrets s ON s.id = sg.secret_id
		 WHERE sg.member_id = $1 AND sg.revoked_at IS NULL`,
		[auth.memberId],
	);

	return ok(c, result.rows);
});

agentApiRoutes.get('/self/system-prompt', async (c) => {
	const db = c.get('db');
	const auth = c.get('auth');

	if (auth.type !== AuthType.Agent) {
		return err(c, 'UNAUTHORIZED', 'Agent token required', 401);
	}

	const result = await db.query(
		`SELECT ma.system_prompt, ma.agent_type_id, at.system_prompt_template AS type_template
		 FROM member_agents ma
		 LEFT JOIN agent_types at ON at.id = ma.agent_type_id
		 WHERE ma.id = $1`,
		[auth.memberId],
	);

	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Agent not found', 404);
	}

	const row = result.rows[0] as {
		system_prompt: string;
		agent_type_id: string | null;
		type_template: string | null;
	};

	return ok(c, {
		system_prompt: row.system_prompt,
		agent_type_id: row.agent_type_id,
		type_template: row.type_template,
	});
});

agentApiRoutes.patch('/self/system-prompt', async (c) => {
	const db = c.get('db');
	const auth = c.get('auth');

	if (auth.type !== AuthType.Agent) {
		return err(c, 'UNAUTHORIZED', 'Agent token required', 401);
	}

	const body = await c.req.json<{ system_prompt: string; reason: string }>();
	if (!body.system_prompt || !body.reason) {
		return err(c, 'INVALID_REQUEST', 'system_prompt and reason are required', 400);
	}

	const result = await db.query<{ id: string; status: string }>(
		`INSERT INTO approvals (company_id, type, requested_by_member_id, payload)
		 VALUES ($1, $2::approval_type, $3, $4::jsonb)
		 RETURNING id, status`,
		[
			auth.companyId,
			ApprovalType.SystemPromptUpdate,
			auth.memberId,
			JSON.stringify({
				member_id: auth.memberId,
				new_system_prompt: body.system_prompt,
				reason: body.reason,
			}),
		],
	);

	return c.json({ data: { approval_id: result.rows[0].id, status: result.rows[0].status } }, 202);
});
