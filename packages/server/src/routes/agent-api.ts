import { Hono } from 'hono';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';

export const agentApiRoutes = new Hono<Env>();

agentApiRoutes.post('/heartbeat', async (c) => {
	const db = c.get('db');
	const auth = c.get('auth');

	if (auth.type !== 'agent') {
		return err(c, 'UNAUTHORIZED', 'Agent token required', 401);
	}

	const { memberId, companyId } = auth;

	await db.query('UPDATE member_agents SET last_heartbeat_at = now() WHERE id = $1', [memberId]);

	const agent = await db.query<{
		id: string;
		title: string;
		status: string;
		system_prompt: string;
		monthly_budget_cents: number;
		budget_used_cents: number;
	}>(
		`SELECT ma.id, ma.title, ma.status, ma.system_prompt,
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

	if (agentRow.status === 'paused' || agentRow.status === 'terminated') {
		return ok(c, {
			agent: {
				id: agentRow.id,
				title: agentRow.title,
				status: agentRow.status,
				budget_remaining_cents: budgetRemaining,
			},
			assigned_issues: [],
			notifications: [],
		});
	}

	const issues = await db.query(
		`SELECT i.id, i.number, i.identifier, i.title, i.description, i.status, i.priority,
		        p.name AS project_name, p.goal AS project_goal, p.id AS project_id,
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
		   AND i.status NOT IN ('done', 'closed', 'cancelled')
		 ORDER BY
		   CASE i.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
		   i.created_at ASC`,
		[memberId, companyId],
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
			status: agentRow.status,
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

	if (auth.type !== 'agent') {
		return err(c, 'UNAUTHORIZED', 'Agent token required', 401);
	}

	const issueId = c.req.param('issueId');
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

	if (auth.type !== 'agent') {
		return err(c, 'UNAUTHORIZED', 'Agent token required', 401);
	}

	const commentId = c.req.param('commentId');
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
			const issueId = c.req.param('issueId');
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
				await db.query("UPDATE member_agents SET status = 'paused'::agent_status WHERE id = $1", [
					auth.memberId,
				]);
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

	if (auth.type !== 'agent') {
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
		 VALUES ($1, 'secret_access'::approval_type, $2::jsonb)
		 RETURNING id, status`,
		[
			auth.companyId,
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

	if (auth.type !== 'agent') {
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
