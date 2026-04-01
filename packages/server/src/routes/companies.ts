import { Hono } from 'hono';
import { err, ok } from '../lib/response';
import { toIssuePrefix, toSlug, uniqueSlug } from '../lib/slug';
import type { Env } from '../lib/types';

export const companiesRoutes = new Hono<Env>();

companiesRoutes.get('/companies', async (c) => {
	const db = c.get('db');
	const result = await db.query(
		`SELECT c.*,
       (SELECT count(*) FROM members m WHERE m.company_id = c.id AND m.member_type = 'agent')::int AS agent_count,
       (SELECT count(*) FROM issues i WHERE i.company_id = c.id AND i.status NOT IN ('done', 'closed', 'cancelled'))::int AS open_issue_count
     FROM companies c
     ORDER BY c.created_at DESC`,
	);
	return ok(c, result.rows);
});

companiesRoutes.post('/companies', async (c) => {
	const body = await c.req.json<{
		name: string;
		description?: string;
		company_type_id?: string;
		issue_prefix?: string;
	}>();

	if (!body.name?.trim()) {
		return err(c, 'INVALID_REQUEST', 'name is required', 400);
	}

	const db = c.get('db');
	const issuePrefix = body.issue_prefix?.trim() || toIssuePrefix(body.name);

	const prefixCheck = await db.query('SELECT id FROM companies WHERE issue_prefix = $1', [
		issuePrefix,
	]);
	if (prefixCheck.rows.length > 0) {
		return err(c, 'CONFLICT', `Issue prefix '${issuePrefix}' is already in use`, 409);
	}

	const slug = await uniqueSlug(toSlug(body.name), async (s) => {
		const r = await db.query('SELECT 1 FROM companies WHERE slug = $1', [s]);
		return r.rows.length > 0;
	});

	const companyResult = await db.query(
		`INSERT INTO companies (name, slug, description, company_type_id, issue_prefix)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
		[body.name.trim(), slug, body.description ?? '', body.company_type_id ?? null, issuePrefix],
	);
	const company = companyResult.rows[0] as any;

	// Initialize issue counter
	await db.query('INSERT INTO company_issue_counters (company_id, next_number) VALUES ($1, 1)', [
		company.id,
	]);

	// Auto-create agents from company type
	if (body.company_type_id) {
		const typeResult = await db.query<{ agents_config: any }>(
			'SELECT agents_config FROM company_types WHERE id = $1',
			[body.company_type_id],
		);

		if (typeResult.rows.length > 0) {
			const agentsConfig = typeResult.rows[0].agents_config;
			if (Array.isArray(agentsConfig) && agentsConfig.length > 0) {
				await createAgentsFromConfig(db, company.id, agentsConfig);
			}
		}
	}

	// Re-fetch with counts
	const result = await db.query(
		`SELECT c.*,
       (SELECT count(*) FROM members m WHERE m.company_id = c.id AND m.member_type = 'agent')::int AS agent_count,
       0 AS open_issue_count
     FROM companies c WHERE c.id = $1`,
		[company.id],
	);

	return ok(c, result.rows[0], 201);
});

companiesRoutes.get('/companies/:companyId', async (c) => {
	const db = c.get('db');
	const result = await db.query(
		`SELECT c.*,
       (SELECT count(*) FROM members m WHERE m.company_id = c.id AND m.member_type = 'agent')::int AS agent_count,
       (SELECT count(*) FROM issues i WHERE i.company_id = c.id AND i.status NOT IN ('done', 'closed', 'cancelled'))::int AS open_issue_count
     FROM companies c WHERE c.id = $1`,
		[c.req.param('companyId')],
	);

	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Company not found', 404);
	}

	return ok(c, result.rows[0]);
});

companiesRoutes.patch('/companies/:companyId', async (c) => {
	const db = c.get('db');
	const id = c.req.param('companyId');

	const existing = await db.query('SELECT id FROM companies WHERE id = $1', [id]);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Company not found', 404);
	}

	const body = await c.req.json<{
		name?: string;
		description?: string;
		mcp_servers?: unknown[];
		mpp_config?: Record<string, unknown>;
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

	if (body.name?.trim()) {
		const newSlug = await uniqueSlug(toSlug(body.name), async (s) => {
			const r = await db.query('SELECT 1 FROM companies WHERE slug = $1 AND id != $2', [s, id]);
			return r.rows.length > 0;
		});
		addField('name', body.name.trim());
		addField('slug', newSlug);
	}
	addField('description', body.description);
	addField('mcp_servers', body.mcp_servers, true);
	addField('mpp_config', body.mpp_config, true);

	if (sets.length === 0) {
		const result = await db.query('SELECT * FROM companies WHERE id = $1', [id]);
		return ok(c, result.rows[0]);
	}

	params.push(id);
	const result = await db.query(
		`UPDATE companies SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
		params,
	);

	return ok(c, result.rows[0]);
});

companiesRoutes.delete('/companies/:companyId', async (c) => {
	const db = c.get('db');
	const id = c.req.param('companyId');

	const existing = await db.query('SELECT id FROM companies WHERE id = $1', [id]);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Company not found', 404);
	}

	await db.query('DELETE FROM companies WHERE id = $1', [id]);
	return c.json({ data: null }, 200);
});

interface AgentConfig {
	title: string;
	slug: string;
	reports_to_slug: string | null;
	runtime_type: string;
	heartbeat_interval_min: number;
	monthly_budget_cents: number;
	role_description: string;
	status: string;
	system_prompt?: string;
}

async function createAgentsFromConfig(
	db: any,
	companyId: string,
	agentsConfig: AgentConfig[],
): Promise<void> {
	// Pass 1: Create all members and agents with reports_to = NULL
	const slugToMemberId = new Map<string, string>();

	for (const agent of agentsConfig) {
		const memberResult = await db.query(
			`INSERT INTO members (company_id, member_type, display_name)
       VALUES ($1, 'agent', $2)
       RETURNING id`,
			[companyId, agent.title],
		);
		const memberId = memberResult.rows[0].id;
		slugToMemberId.set(agent.slug, memberId);

		await db.query(
			`INSERT INTO member_agents (id, title, slug, role_description, system_prompt, runtime_type, heartbeat_interval_min, monthly_budget_cents, status)
       VALUES ($1, $2, $3, $4, $5, $6::agent_runtime, $7, $8, $9::agent_status)`,
			[
				memberId,
				agent.title,
				agent.slug,
				agent.role_description ?? '',
				agent.system_prompt ?? '',
				agent.runtime_type ?? 'claude_code',
				agent.heartbeat_interval_min ?? 60,
				agent.monthly_budget_cents ?? 3000,
				agent.status ?? 'active',
			],
		);
	}

	// Pass 2: Update reports_to references
	for (const agent of agentsConfig) {
		if (agent.reports_to_slug && agent.reports_to_slug !== 'board') {
			const reportsToId = slugToMemberId.get(agent.reports_to_slug);
			if (reportsToId) {
				const memberId = slugToMemberId.get(agent.slug);
				await db.query('UPDATE member_agents SET reports_to = $1 WHERE id = $2', [
					reportsToId,
					memberId,
				]);
			}
		}
	}
}

export { createAgentsFromConfig };
