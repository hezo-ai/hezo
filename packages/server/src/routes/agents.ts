import { AgentStatus, MemberType, TERMINAL_ISSUE_STATUSES } from '@hezo/shared';
import { Hono } from 'hono';
import { broadcastChange } from '../lib/broadcast';
import { err, ok } from '../lib/response';
import { toSlug } from '../lib/slug';
import type { Env } from '../lib/types';
import { requireCompanyAccess } from '../middleware/auth';

export const agentsRoutes = new Hono<Env>();

const terminalStatusList = TERMINAL_ISSUE_STATUSES.map((s) => `'${s}'`).join(', ');

agentsRoutes.get('/companies/:companyId/agents', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const statusFilter = c.req.query('status');

	let query = `
    SELECT m.id, m.company_id, m.display_name, m.created_at,
           ma.title, ma.slug, ma.role_description, ma.system_prompt, ma.runtime_type,
           ma.heartbeat_interval_min, ma.monthly_budget_cents, ma.budget_used_cents,
           ma.budget_reset_at, ma.status, ma.last_heartbeat_at, ma.updated_at,
           ma.reports_to,
           (SELECT ma2.title FROM member_agents ma2 WHERE ma2.id = ma.reports_to) AS reports_to_title,
           (SELECT count(*) FROM issues i WHERE i.assignee_id = m.id AND i.status NOT IN (${terminalStatusList}))::int AS assigned_issue_count
    FROM members m
    JOIN member_agents ma ON ma.id = m.id
    WHERE m.company_id = $1`;
	const params: unknown[] = [companyId];

	if (statusFilter) {
		const statuses = statusFilter.split(',').map((s) => s.trim());
		const placeholders = statuses
			.map((_, i) => `$${params.length + 1 + i}::agent_status`)
			.join(', ');
		query += ` AND ma.status IN (${placeholders})`;
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
		heartbeat_interval_min?: number;
		monthly_budget_cents?: number;
		mcp_servers?: unknown[];
	}>();

	if (!body.title?.trim()) {
		return err(c, 'INVALID_REQUEST', 'title is required', 400);
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

	const memberResult = await db.query<{ id: string }>(
		`INSERT INTO members (company_id, member_type, display_name)
     VALUES ($1, $2, $3)
     RETURNING id`,
		[companyId, MemberType.Agent, body.title.trim()],
	);
	const memberId = memberResult.rows[0].id;

	await db.query(
		`INSERT INTO member_agents (id, title, slug, role_description, system_prompt, reports_to, runtime_type, heartbeat_interval_min, monthly_budget_cents, mcp_servers)
     VALUES ($1, $2, $3, $4, $5, $6, $7::agent_runtime, $8, $9, $10::jsonb)`,
		[
			memberId,
			body.title.trim(),
			slug,
			body.role_description ?? '',
			body.system_prompt ?? '',
			body.reports_to ?? null,
			body.runtime_type ?? 'claude_code',
			body.heartbeat_interval_min ?? 60,
			body.monthly_budget_cents ?? 3000,
			JSON.stringify(body.mcp_servers ?? []),
		],
	);

	const result = await db.query(
		`SELECT m.id, m.company_id, m.display_name, m.created_at,
            ma.title, ma.slug, ma.role_description, ma.system_prompt, ma.runtime_type,
            ma.heartbeat_interval_min, ma.monthly_budget_cents, ma.budget_used_cents,
            ma.status, ma.reports_to, ma.mcp_servers, ma.updated_at
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
});

agentsRoutes.get('/companies/:companyId/agents/:agentId', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;

	const result = await db.query(
		`SELECT m.id, m.company_id, m.display_name, m.created_at,
            ma.title, ma.slug, ma.role_description, ma.system_prompt, ma.runtime_type,
            ma.heartbeat_interval_min, ma.monthly_budget_cents, ma.budget_used_cents,
            ma.budget_reset_at, ma.status, ma.last_heartbeat_at, ma.reports_to,
            ma.mcp_servers, ma.updated_at,
            (SELECT ma2.title FROM member_agents ma2 WHERE ma2.id = ma.reports_to) AS reports_to_title,
            (SELECT count(*) FROM issues i WHERE i.assignee_id = m.id AND i.status NOT IN (${terminalStatusList}))::int AS assigned_issue_count
     FROM members m
     JOIN member_agents ma ON ma.id = m.id
     WHERE m.id = $1 AND m.company_id = $2`,
		[c.req.param('agentId'), companyId],
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
		heartbeat_interval_min?: number;
		monthly_budget_cents?: number;
		mcp_servers?: unknown[];
	}>();

	const sets: string[] = [];
	const params: unknown[] = [];
	let idx = 1;

	const addField = (field: string, value: unknown, jsonb = false) => {
		if (value !== undefined) {
			sets.push(`${field} = $${idx}${jsonb ? '::jsonb' : ''}`);
			params.push(jsonb ? JSON.stringify(value) : value);
			idx++;
		}
	};

	addField('title', body.title?.trim());
	addField('role_description', body.role_description);
	addField('system_prompt', body.system_prompt);
	addField('reports_to', body.reports_to);
	addField('heartbeat_interval_min', body.heartbeat_interval_min);
	addField('monthly_budget_cents', body.monthly_budget_cents);
	addField('mcp_servers', body.mcp_servers, true);

	if (sets.length === 0) {
		const result = await db.query(
			`SELECT m.*, ma.* FROM members m JOIN member_agents ma ON ma.id = m.id WHERE m.id = $1`,
			[agentId],
		);
		return ok(c, result.rows[0]);
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

	broadcastChange(
		c,
		`company:${companyId}`,
		'member_agents',
		'UPDATE',
		result.rows[0] as Record<string, unknown>,
	);
	return ok(c, result.rows[0]);
});

agentsRoutes.post('/companies/:companyId/agents/:agentId/pause', async (c) => {
	return changeAgentStatus(c, AgentStatus.Paused, [AgentStatus.Active]);
});

agentsRoutes.post('/companies/:companyId/agents/:agentId/resume', async (c) => {
	return changeAgentStatus(c, AgentStatus.Idle, [AgentStatus.Paused]);
});

agentsRoutes.post('/companies/:companyId/agents/:agentId/terminate', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const agentId = c.req.param('agentId');

	const existing = await db.query<{ status: string }>(
		'SELECT ma.status FROM members m JOIN member_agents ma ON ma.id = m.id WHERE m.id = $1 AND m.company_id = $2',
		[agentId, companyId],
	);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Agent not found', 404);
	}
	if (existing.rows[0].status === AgentStatus.Terminated) {
		return err(c, 'INVALID_STATE', 'Agent is already terminated', 409);
	}

	await db.query(`UPDATE member_agents SET status = $1::agent_status WHERE id = $2`, [
		AgentStatus.Terminated,
		agentId,
	]);

	const terminalPlaceholders = TERMINAL_ISSUE_STATUSES.map((_, i) => `$${i + 2}`).join(', ');
	await db.query(
		`UPDATE issues SET assignee_id = NULL WHERE assignee_id = $1 AND status NOT IN (${terminalPlaceholders})`,
		[agentId, ...TERMINAL_ISSUE_STATUSES],
	);

	broadcastChange(c, `company:${companyId}`, 'member_agents', 'UPDATE', {
		id: agentId,
		status: AgentStatus.Terminated,
	});
	return ok(c, { status: AgentStatus.Terminated });
});

agentsRoutes.get('/companies/:companyId/org-chart', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;

	const result = await db.query(
		`SELECT m.id, ma.title, ma.slug, ma.status, ma.reports_to
     FROM members m
     JOIN member_agents ma ON ma.id = m.id
     WHERE m.company_id = $1`,
		[companyId],
	);

	const agents = result.rows as {
		id: string;
		title: string;
		slug: string;
		status: string;
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

async function changeAgentStatus(
	c: import('hono').Context<Env>,
	newStatus: string,
	validFrom: string[],
) {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const agentId = c.req.param('agentId');

	const existing = await db.query<{ status: string }>(
		'SELECT ma.status FROM members m JOIN member_agents ma ON ma.id = m.id WHERE m.id = $1 AND m.company_id = $2',
		[agentId, companyId],
	);

	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Agent not found', 404);
	}

	if (!validFrom.includes(existing.rows[0].status)) {
		return err(
			c,
			'INVALID_STATE',
			`Cannot transition from '${existing.rows[0].status}' to '${newStatus}'`,
			409,
		);
	}

	await db.query(`UPDATE member_agents SET status = $1::agent_status WHERE id = $2`, [
		newStatus,
		agentId,
	]);

	broadcastChange(c, `company:${companyId}`, 'member_agents', 'UPDATE', {
		id: agentId,
		status: newStatus,
	});
	return ok(c, { status: newStatus });
}

agentsRoutes.get('/companies/:companyId/agents/:agentId/heartbeat-runs', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const agentId = c.req.param('agentId');

	const result = await db.query(
		`SELECT id, member_id, company_id, wakeup_id, status,
		        started_at, finished_at, exit_code, error,
		        input_tokens, output_tokens, cost_cents,
		        stdout_excerpt, stderr_excerpt, process_pid,
		        retry_of_run_id, process_loss_retry_count
		 FROM heartbeat_runs
		 WHERE member_id = $1
		 ORDER BY started_at DESC
		 LIMIT 20`,
		[agentId],
	);

	return ok(c, result.rows);
});
