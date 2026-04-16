import {
	AgentAdminStatus,
	DEFAULT_EFFORT,
	IssuePriority,
	IssueStatus,
	isAgentEffort,
	MemberType,
} from '@hezo/shared';
import { Hono } from 'hono';
import { broadcastChange } from '../lib/broadcast';
import { err, ok } from '../lib/response';
import { toSlug } from '../lib/slug';
import { buildUpdateSet, terminalStatusParams } from '../lib/sql';
import type { Env } from '../lib/types';
import { requireCompanyAccess } from '../middleware/auth';

export const agentsRoutes = new Hono<Env>();

/**
 * Common projection for agent rows. JOIN against `members m` and `member_agents ma`.
 * `assigned_issue_count` requires the caller to bind terminal statuses via `terminalStatusParams`.
 */
const AGENT_BASE_COLUMNS = `m.id, m.company_id, m.display_name, m.created_at,
	ma.agent_type_id, ma.title, ma.slug, ma.role_description, ma.system_prompt, ma.runtime_type,
	ma.default_effort,
	ma.heartbeat_interval_min, ma.monthly_budget_cents, ma.budget_used_cents,
	ma.budget_reset_at, ma.runtime_status, ma.admin_status, ma.last_heartbeat_at, ma.reports_to,
	ma.mcp_servers, ma.updated_at`;

const HEARTBEAT_RUN_COLUMNS = `hr.id, hr.member_id, hr.company_id, hr.wakeup_id, hr.issue_id,
	hr.status, hr.started_at, hr.finished_at, hr.exit_code, hr.error,
	hr.input_tokens, hr.output_tokens, hr.cost_cents,
	hr.invocation_command, hr.log_text, hr.working_dir,
	hr.process_pid, hr.retry_of_run_id, hr.process_loss_retry_count,
	i.identifier AS issue_identifier, i.title AS issue_title,
	i.project_id AS project_id`;

agentsRoutes.get('/companies/:companyId/agents', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const adminFilter = c.req.query('admin_status');

	const ts = terminalStatusParams(2);
	let query = `
		SELECT ${AGENT_BASE_COLUMNS},
			(SELECT ma2.title FROM member_agents ma2 WHERE ma2.id = ma.reports_to) AS reports_to_title,
			(SELECT count(*) FROM issues i WHERE i.assignee_id = m.id AND i.status NOT IN (${ts.placeholders}))::int AS assigned_issue_count
		FROM members m
		JOIN member_agents ma ON ma.id = m.id
		WHERE m.company_id = $1`;
	const params: unknown[] = [companyId, ...ts.values];

	if (adminFilter) {
		const statuses = adminFilter.split(',').map((s) => s.trim());
		const placeholders = statuses
			.map((_, i) => `$${params.length + 1 + i}::agent_admin_status`)
			.join(', ');
		query += ` AND ma.admin_status IN (${placeholders})`;
		params.push(...statuses);
	}

	query += ' ORDER BY ma.title ASC';

	const result = await db.query(query, params);
	return ok(c, result.rows);
});

agentsRoutes.post('/companies/:companyId/agents', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;

	const companyCheck = await db.query('SELECT id FROM companies WHERE id = $1', [companyId]);
	if (companyCheck.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Company not found', 404);
	}

	const body = await c.req.json<{
		title: string;
		role_description?: string;
		system_prompt?: string;
		reports_to?: string;
		runtime_type?: string;
		default_effort?: string;
		heartbeat_interval_min?: number;
		monthly_budget_cents?: number;
		mcp_servers?: unknown[];
	}>();

	if (!body.title?.trim()) {
		return err(c, 'INVALID_REQUEST', 'title is required', 400);
	}

	if (body.default_effort !== undefined && !isAgentEffort(body.default_effort)) {
		return err(c, 'INVALID_REQUEST', `Invalid default_effort: ${body.default_effort}`, 400);
	}

	const slug = toSlug(body.title);

	const slugCheck = await db.query(
		`SELECT ma.id FROM member_agents ma
     JOIN members m ON m.id = ma.id
     WHERE m.company_id = $1 AND ma.slug = $2`,
		[companyId, slug],
	);
	if (slugCheck.rows.length > 0) {
		return err(c, 'CONFLICT', `Agent with slug '${slug}' already exists in this company`, 409);
	}

	await db.query('BEGIN');
	try {
		const memberResult = await db.query<{ id: string }>(
			`INSERT INTO members (company_id, member_type, display_name)
       VALUES ($1, $2, $3)
       RETURNING id`,
			[companyId, MemberType.Agent, body.title.trim()],
		);
		const memberId = memberResult.rows[0].id;

		await db.query(
			`INSERT INTO member_agents (id, title, slug, role_description, system_prompt, reports_to, runtime_type, default_effort, heartbeat_interval_min, monthly_budget_cents, mcp_servers)
       VALUES ($1, $2, $3, $4, $5, $6, $7::agent_runtime, $8::agent_effort, $9, $10, $11::jsonb)`,
			[
				memberId,
				body.title.trim(),
				slug,
				body.role_description ?? '',
				body.system_prompt ?? '',
				body.reports_to ?? null,
				body.runtime_type ?? 'claude_code',
				body.default_effort ?? DEFAULT_EFFORT,
				body.heartbeat_interval_min ?? 60,
				body.monthly_budget_cents ?? 3000,
				JSON.stringify(body.mcp_servers ?? []),
			],
		);

		await db.query('COMMIT');

		const result = await db.query(
			`SELECT ${AGENT_BASE_COLUMNS}
			 FROM members m
			 JOIN member_agents ma ON ma.id = m.id
			 WHERE m.id = $1`,
			[memberId],
		);

		broadcastChange(
			c,
			`company:${companyId}`,
			'member_agents',
			'INSERT',
			result.rows[0] as Record<string, unknown>,
		);
		return ok(c, result.rows[0], 201);
	} catch (e) {
		await db.query('ROLLBACK');
		throw e;
	}
});

agentsRoutes.post('/companies/:companyId/agents/onboard', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;

	const body = await c.req.json<{
		title: string;
		role_description?: string;
		system_prompt?: string;
		runtime_type?: string;
		default_effort?: string;
		heartbeat_interval_min?: number;
		monthly_budget_cents?: number;
	}>();

	if (!body.title?.trim()) {
		return err(c, 'INVALID_REQUEST', 'title is required', 400);
	}

	if (body.default_effort !== undefined && !isAgentEffort(body.default_effort)) {
		return err(c, 'INVALID_REQUEST', `Invalid default_effort: ${body.default_effort}`, 400);
	}

	const slug = toSlug(body.title);
	const slugCheck = await db.query(
		`SELECT ma.id FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.company_id = $1 AND ma.slug = $2`,
		[companyId, slug],
	);
	if (slugCheck.rows.length > 0) {
		return err(c, 'CONFLICT', `Agent with slug '${slug}' already exists in this company`, 409);
	}

	const ceoResult = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.company_id = $1 AND ma.slug = 'ceo' AND ma.admin_status = $2::agent_admin_status`,
		[companyId, AgentAdminStatus.Enabled],
	);

	const opsProject = await db.query<{ id: string }>(
		`SELECT id FROM projects WHERE company_id = $1 AND is_internal = true AND slug = 'operations'`,
		[companyId],
	);

	const hasCeo = ceoResult.rows.length > 0;
	const hasOpsProject = opsProject.rows.length > 0;

	await db.query('BEGIN');
	try {
		const memberResult = await db.query<{ id: string }>(
			`INSERT INTO members (company_id, member_type, display_name)
			 VALUES ($1, $2, $3)
			 RETURNING id`,
			[companyId, MemberType.Agent, body.title.trim()],
		);
		const memberId = memberResult.rows[0].id;

		const adminStatus =
			hasCeo && hasOpsProject ? AgentAdminStatus.Disabled : AgentAdminStatus.Enabled;

		await db.query(
			`INSERT INTO member_agents (id, title, slug, role_description, system_prompt,
			                            runtime_type, default_effort, heartbeat_interval_min, monthly_budget_cents, admin_status)
			 VALUES ($1, $2, $3, $4, $5, $6::agent_runtime, $7::agent_effort, $8, $9, $10::agent_admin_status)`,
			[
				memberId,
				body.title.trim(),
				slug,
				body.role_description ?? '',
				body.system_prompt ?? '',
				body.runtime_type ?? 'claude_code',
				body.default_effort ?? DEFAULT_EFFORT,
				body.heartbeat_interval_min ?? 60,
				body.monthly_budget_cents ?? 3000,
				adminStatus,
			],
		);

		let issue = null;

		if (hasCeo && hasOpsProject) {
			const ceoId = ceoResult.rows[0].id;
			const projectId = opsProject.rows[0].id;

			const existingAgents = await db.query<{ title: string; role_description: string }>(
				`SELECT ma.title, ma.role_description
				 FROM member_agents ma JOIN members m ON m.id = ma.id
				 WHERE m.company_id = $1 AND ma.admin_status = $2::agent_admin_status AND ma.id != $3`,
				[companyId, AgentAdminStatus.Enabled, memberId],
			);

			const teamRoster = existingAgents.rows
				.map((a) => `- **${a.title}**: ${a.role_description || 'No description'}`)
				.join('\n');

			const description = `## New Agent Onboarding Request

**Role**: ${body.title.trim()}
**Role Description**: ${body.role_description || 'Not provided'}

### Task
Review this new hire against the existing team. Consider:
1. Reporting structure — who should this agent report to?
2. Responsibility overlap with existing agents
3. Any adjustments needed to existing agents' responsibilities

### Existing Team
${teamRoster}`;

			const companyResult = await db.query<{ issue_prefix: string }>(
				'SELECT issue_prefix FROM companies WHERE id = $1',
				[companyId],
			);
			const numberResult = await db.query<{ number: number }>(
				'SELECT next_issue_number($1) AS number',
				[companyId],
			);
			const issueNumber = numberResult.rows[0].number;
			const identifier = `${companyResult.rows[0].issue_prefix}-${issueNumber}`;

			const issueResult = await db.query(
				`INSERT INTO issues (company_id, project_id, assignee_id, number, identifier,
				                     title, description, status, priority, labels)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::issue_status, $9::issue_priority, $10::jsonb)
				 RETURNING *`,
				[
					companyId,
					projectId,
					ceoId,
					issueNumber,
					identifier,
					`Onboard new agent: ${body.title.trim()}`,
					description,
					IssueStatus.Open,
					IssuePriority.High,
					JSON.stringify(['onboarding']),
				],
			);
			issue = issueResult.rows[0];
		}

		await db.query('COMMIT');

		const agentResult = await db.query(
			`SELECT ${AGENT_BASE_COLUMNS}
			 FROM members m
			 JOIN member_agents ma ON ma.id = m.id
			 WHERE m.id = $1`,
			[memberId],
		);

		broadcastChange(
			c,
			`company:${companyId}`,
			'member_agents',
			'INSERT',
			agentResult.rows[0] as Record<string, unknown>,
		);
		if (issue) {
			broadcastChange(
				c,
				`company:${companyId}`,
				'issues',
				'INSERT',
				issue as Record<string, unknown>,
			);
		}

		return ok(c, { agent: agentResult.rows[0], issue }, 201);
	} catch (e) {
		await db.query('ROLLBACK');
		throw e;
	}
});

agentsRoutes.get('/companies/:companyId/agents/:agentId', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;

	const ts2 = terminalStatusParams(3);
	const result = await db.query(
		`SELECT ${AGENT_BASE_COLUMNS},
			(SELECT ma2.title FROM member_agents ma2 WHERE ma2.id = ma.reports_to) AS reports_to_title,
			(SELECT count(*) FROM issues i WHERE i.assignee_id = m.id AND i.status NOT IN (${ts2.placeholders}))::int AS assigned_issue_count
		 FROM members m
		 JOIN member_agents ma ON ma.id = m.id
		 WHERE m.id = $1 AND m.company_id = $2`,
		[c.req.param('agentId'), companyId, ...ts2.values],
	);

	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Agent not found', 404);
	}

	return ok(c, result.rows[0]);
});

agentsRoutes.patch('/companies/:companyId/agents/:agentId', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const agentId = c.req.param('agentId');

	const existing = await db.query(
		'SELECT m.id FROM members m JOIN member_agents ma ON ma.id = m.id WHERE m.id = $1 AND m.company_id = $2',
		[agentId, companyId],
	);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Agent not found', 404);
	}

	const body = await c.req.json<{
		title?: string;
		role_description?: string;
		system_prompt?: string;
		reports_to?: string | null;
		default_effort?: string;
		heartbeat_interval_min?: number;
		monthly_budget_cents?: number;
		mcp_servers?: unknown[];
	}>();

	if (body.default_effort !== undefined && !isAgentEffort(body.default_effort)) {
		return err(c, 'INVALID_REQUEST', `Invalid default_effort: ${body.default_effort}`, 400);
	}

	const {
		clauses: sets,
		params,
		nextIdx,
	} = buildUpdateSet([
		{ column: 'title', value: body.title?.trim() },
		{ column: 'role_description', value: body.role_description },
		{ column: 'system_prompt', value: body.system_prompt },
		{ column: 'reports_to', value: body.reports_to },
		{ column: 'default_effort', value: body.default_effort, cast: 'agent_effort' },
		{ column: 'heartbeat_interval_min', value: body.heartbeat_interval_min },
		{ column: 'monthly_budget_cents', value: body.monthly_budget_cents },
		{ column: 'mcp_servers', value: body.mcp_servers, cast: 'jsonb' },
	]);
	const idx = nextIdx;

	if (sets.length === 0) {
		const result = await db.query(
			`SELECT m.*, ma.* FROM members m JOIN member_agents ma ON ma.id = m.id WHERE m.id = $1`,
			[agentId],
		);
		return ok(c, result.rows[0]);
	}

	// Capture old prompt before update for revision tracking
	let oldSystemPrompt: string | null = null;
	if (body.system_prompt !== undefined) {
		const oldResult = await db.query<{ system_prompt: string }>(
			'SELECT system_prompt FROM member_agents WHERE id = $1',
			[agentId],
		);
		oldSystemPrompt = oldResult.rows[0]?.system_prompt ?? '';
	}

	if (body.title?.trim()) {
		await db.query('UPDATE members SET display_name = $1 WHERE id = $2', [
			body.title.trim(),
			agentId,
		]);
	}

	params.push(agentId);
	const result = await db.query(
		`UPDATE member_agents SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
		params,
	);

	// Record system prompt revision if prompt was changed
	if (body.system_prompt !== undefined && oldSystemPrompt !== null) {
		const revNum = await db.query<{ n: number }>(
			'SELECT COALESCE(MAX(revision_number), 0) + 1 AS n FROM system_prompt_revisions WHERE member_agent_id = $1',
			[agentId],
		);
		await db.query(
			`INSERT INTO system_prompt_revisions (member_agent_id, company_id, revision_number, old_prompt, new_prompt, change_summary)
			 VALUES ($1, $2, $3, $4, $5, $6)`,
			[
				agentId,
				companyId,
				revNum.rows[0].n,
				oldSystemPrompt,
				body.system_prompt,
				'Manual edit by board member',
			],
		);
	}

	broadcastChange(
		c,
		`company:${companyId}`,
		'member_agents',
		'UPDATE',
		result.rows[0] as Record<string, unknown>,
	);
	return ok(c, result.rows[0]);
});

agentsRoutes.post('/companies/:companyId/agents/:agentId/disable', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const agentId = c.req.param('agentId');

	const existing = await db.query<{ admin_status: string }>(
		'SELECT ma.admin_status FROM members m JOIN member_agents ma ON ma.id = m.id WHERE m.id = $1 AND m.company_id = $2',
		[agentId, companyId],
	);
	if (existing.rows.length === 0) return err(c, 'NOT_FOUND', 'Agent not found', 404);
	if (existing.rows[0].admin_status === AgentAdminStatus.Disabled) {
		return err(c, 'INVALID_STATE', 'Agent is already disabled', 409);
	}

	await db.query(`UPDATE member_agents SET admin_status = $1::agent_admin_status WHERE id = $2`, [
		AgentAdminStatus.Disabled,
		agentId,
	]);

	const ts = terminalStatusParams(2, false);
	await db.query(
		`UPDATE issues SET assignee_id = NULL WHERE assignee_id = $1 AND status NOT IN (${ts.placeholders})`,
		[agentId, ...ts.values],
	);

	broadcastChange(c, `company:${companyId}`, 'member_agents', 'UPDATE', {
		id: agentId,
		admin_status: AgentAdminStatus.Disabled,
	});
	return ok(c, { admin_status: AgentAdminStatus.Disabled });
});

agentsRoutes.post('/companies/:companyId/agents/:agentId/enable', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const agentId = c.req.param('agentId');

	const existing = await db.query<{ admin_status: string }>(
		'SELECT ma.admin_status FROM members m JOIN member_agents ma ON ma.id = m.id WHERE m.id = $1 AND m.company_id = $2',
		[agentId, companyId],
	);
	if (existing.rows.length === 0) return err(c, 'NOT_FOUND', 'Agent not found', 404);
	if (existing.rows[0].admin_status === AgentAdminStatus.Enabled) {
		return err(c, 'INVALID_STATE', 'Agent is already enabled', 409);
	}

	await db.query(`UPDATE member_agents SET admin_status = $1::agent_admin_status WHERE id = $2`, [
		AgentAdminStatus.Enabled,
		agentId,
	]);

	broadcastChange(c, `company:${companyId}`, 'member_agents', 'UPDATE', {
		id: agentId,
		admin_status: AgentAdminStatus.Enabled,
	});
	return ok(c, { admin_status: AgentAdminStatus.Enabled });
});

agentsRoutes.get('/companies/:companyId/org-chart', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;

	const result = await db.query(
		`SELECT m.id, ma.title, ma.slug, ma.runtime_status, ma.admin_status, ma.reports_to
     FROM members m
     JOIN member_agents ma ON ma.id = m.id
     WHERE m.company_id = $1`,
		[companyId],
	);

	const agents = result.rows as {
		id: string;
		title: string;
		slug: string;
		runtime_status: string;
		admin_status: string;
		reports_to: string | null;
	}[];
	type AgentNode = (typeof agents)[number] & { children: AgentNode[] };
	const byId = new Map(agents.map((a) => [a.id, { ...a, children: [] as AgentNode[] }]));

	const roots: AgentNode[] = [];
	for (const agent of byId.values()) {
		if (agent.reports_to && byId.has(agent.reports_to)) {
			byId.get(agent.reports_to)?.children.push(agent);
		} else {
			roots.push(agent);
		}
	}

	return ok(c, { board: { children: roots } });
});

agentsRoutes.get('/companies/:companyId/agents/:agentId/heartbeat-runs', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const agentId = c.req.param('agentId');

	const result = await db.query(
		`SELECT ${HEARTBEAT_RUN_COLUMNS}
		 FROM heartbeat_runs hr
		 LEFT JOIN issues i ON i.id = hr.issue_id
		 WHERE hr.member_id = $1
		 ORDER BY hr.started_at DESC
		 LIMIT 50`,
		[agentId],
	);

	return ok(c, result.rows);
});

agentsRoutes.get('/companies/:companyId/agents/:agentId/heartbeat-runs/:runId', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const agentId = c.req.param('agentId');
	const runId = c.req.param('runId');

	const result = await db.query(
		`SELECT ${HEARTBEAT_RUN_COLUMNS}
		 FROM heartbeat_runs hr
		 LEFT JOIN issues i ON i.id = hr.issue_id
		 WHERE hr.id = $1 AND hr.member_id = $2`,
		[runId, agentId],
	);

	if (result.rows.length === 0) return c.json({ error: 'Run not found' }, 404);
	return ok(c, result.rows[0]);
});
