import { Hono } from 'hono';
import { broadcastChange } from '../lib/broadcast';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { requireCompanyAccess } from '../middleware/auth';

export const costsRoutes = new Hono<Env>();

costsRoutes.get('/companies/:companyId/costs', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;
	const agentId = c.req.query('agent_id');
	const projectId = c.req.query('project_id');
	const issueId = c.req.query('issue_id');
	const from = c.req.query('from');
	const to = c.req.query('to');
	const groupBy = c.req.query('group_by');

	const conditions: string[] = ['ce.company_id = $1'];
	const params: unknown[] = [companyId];
	let idx = 2;

	if (agentId) {
		conditions.push(`ce.member_id = $${idx}`);
		params.push(agentId);
		idx++;
	}
	if (projectId) {
		conditions.push(`ce.project_id = $${idx}`);
		params.push(projectId);
		idx++;
	}
	if (issueId) {
		conditions.push(`ce.issue_id = $${idx}`);
		params.push(issueId);
		idx++;
	}
	if (from) {
		conditions.push(`ce.created_at >= $${idx}`);
		params.push(from);
		idx++;
	}
	if (to) {
		conditions.push(`ce.created_at <= $${idx}`);
		params.push(to);
		idx++;
	}

	const where = conditions.join(' AND ');

	if (groupBy === 'agent') {
		const result = await db.query<{ total_cents: number }>(
			`SELECT ce.member_id AS agent_id,
              COALESCE(ma.title, m.display_name) AS agent_title,
              sum(ce.amount_cents)::int AS total_cents
       FROM cost_entries ce
       LEFT JOIN members m ON m.id = ce.member_id
       LEFT JOIN member_agents ma ON ma.id = ce.member_id
       WHERE ${where}
       GROUP BY ce.member_id, ma.title, m.display_name`,
			params,
		);
		const totalCents = result.rows.reduce((sum, r) => sum + r.total_cents, 0);
		return ok(c, { summary: result.rows, total_cents: totalCents });
	}

	if (groupBy === 'project') {
		const result = await db.query<{ total_cents: number }>(
			`SELECT ce.project_id, p.name AS project_name,
              sum(ce.amount_cents)::int AS total_cents
       FROM cost_entries ce
       LEFT JOIN projects p ON p.id = ce.project_id
       WHERE ${where}
       GROUP BY ce.project_id, p.name`,
			params,
		);
		const totalCents = result.rows.reduce((sum, r) => sum + r.total_cents, 0);
		return ok(c, { summary: result.rows, total_cents: totalCents });
	}

	if (groupBy === 'day') {
		const result = await db.query<{ total_cents: number }>(
			`SELECT date_trunc('day', ce.created_at)::date AS day,
              sum(ce.amount_cents)::int AS total_cents
       FROM cost_entries ce
       WHERE ${where}
       GROUP BY day ORDER BY day`,
			params,
		);
		const totalCents = result.rows.reduce((sum, r) => sum + r.total_cents, 0);
		return ok(c, { summary: result.rows, total_cents: totalCents });
	}

	const result = await db.query<{ amount_cents: number }>(
		`SELECT ce.* FROM cost_entries ce WHERE ${where} ORDER BY ce.created_at DESC`,
		params,
	);
	const totalCents = result.rows.reduce((sum, r) => sum + r.amount_cents, 0);
	return ok(c, { entries: result.rows, total_cents: totalCents });
});

costsRoutes.post('/companies/:companyId/costs', async (c) => {
	const access = await requireCompanyAccess(c);
	if (access instanceof Response) return access;

	const db = c.get('db');
	const { companyId } = access;

	const body = await c.req.json<{
		member_id: string;
		amount_cents: number;
		issue_id?: string;
		project_id?: string;
		description?: string;
	}>();

	if (!body.member_id || body.amount_cents == null || body.amount_cents <= 0) {
		return err(c, 'INVALID_REQUEST', 'member_id and positive amount_cents are required', 400);
	}

	const debitResult = await db.query<{ debit_agent_budget: boolean }>(
		'SELECT debit_agent_budget($1, $2)',
		[body.member_id, body.amount_cents],
	);

	if (!debitResult.rows[0].debit_agent_budget) {
		return err(c, 'BUDGET_EXCEEDED', 'Agent or company budget exceeded', 402);
	}

	const result = await db.query(
		`INSERT INTO cost_entries (company_id, member_id, issue_id, project_id, amount_cents, description)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
		[
			companyId,
			body.member_id,
			body.issue_id ?? null,
			body.project_id ?? null,
			body.amount_cents,
			body.description ?? '',
		],
	);

	broadcastChange(
		c,
		`company:${companyId}`,
		'cost_entries',
		'INSERT',
		result.rows[0] as Record<string, unknown>,
	);
	return ok(c, result.rows[0], 201);
});
