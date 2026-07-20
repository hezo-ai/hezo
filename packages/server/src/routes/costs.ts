import { wsRoom } from '@hezo/shared';
import { Hono } from 'hono';
import { broadcastChange } from '../lib/broadcast';
import { AGENT_ICON_URL, signVersionedIconUrl } from '../lib/entity-icon-urls';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { pauseAgentForBudget } from '../services/agent-runtime-status';
import { checkOverBudget, getProjectBudgetStatus, toEntityBudgetStatus } from '../services/budget';

export const costsRoutes = new Hono<Env>();

/**
 * Cost reads are scoped to a single project (`ce.project_id`) — cost is
 * project/agent/adapter-scoped, never team-scoped. `group_by=day` powers the
 * project total chart; `breakdown=agent` / `breakdown=adapter` add a per-day
 * series split for the stacked charts on the Budgets page.
 */
costsRoutes.get('/projects/:projectId/costs', async (c) => {
	const projectId = c.get('projectId') as string;
	const db = c.get('db');
	const agentId = c.req.query('agent_id');
	const taskId = c.req.query('task_id');
	const from = c.req.query('from');
	const to = c.req.query('to');
	const groupBy = c.req.query('group_by');
	const breakdown = c.req.query('breakdown');

	const conditions: string[] = ['ce.project_id = $1'];
	const params: unknown[] = [projectId];
	let idx = 2;

	if (agentId) {
		conditions.push(`ce.member_id = $${idx}`);
		params.push(agentId);
		idx++;
	}
	if (taskId) {
		conditions.push(`ce.task_id = $${idx}`);
		params.push(taskId);
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

	// The per-day buckets cast to `::date::text` (not bare `::date`) on purpose: PGlite
	// deserializes a Postgres `date` into a JS Date, which Hono's c.json() then renders
	// as a full ISO timestamp ("2024-01-15T00:00:00.000Z"). The chart parses `day` as a
	// date-only string, so the timestamp form breaks it ("Invalid Date"). `::text` keeps
	// it a plain "YYYY-MM-DD". Keep the cast on all three group_by=day queries below.
	if (groupBy === 'day' && breakdown === 'agent') {
		const result = await db.query<{ total_cents: number }>(
			`SELECT date_trunc('day', ce.created_at)::date::text AS day,
              ce.member_id AS agent_id,
              COALESCE(ma.title, m.display_name) AS agent_title,
              sum(ce.amount_cents)::int AS total_cents
       FROM cost_entries ce
       LEFT JOIN members m ON m.id = ce.member_id
       LEFT JOIN member_agents ma ON ma.id = ce.member_id
       WHERE ${where}
       GROUP BY day, ce.member_id, ma.title, m.display_name
       ORDER BY day`,
			params,
		);
		const totalCents = result.rows.reduce((sum, r) => sum + r.total_cents, 0);
		return ok(c, { summary: result.rows, total_cents: totalCents });
	}

	if (groupBy === 'day' && breakdown === 'adapter') {
		const result = await db.query<{ total_cents: number }>(
			`SELECT date_trunc('day', ce.created_at)::date::text AS day,
              ce.ai_provider_config_id,
              ce.provider,
              apc.label AS adapter_label,
              sum(ce.amount_cents)::int AS total_cents
       FROM cost_entries ce
       LEFT JOIN ai_provider_configs apc ON apc.id = ce.ai_provider_config_id
       WHERE ${where}
       GROUP BY day, ce.ai_provider_config_id, ce.provider, apc.label
       ORDER BY day`,
			params,
		);
		const totalCents = result.rows.reduce((sum, r) => sum + r.total_cents, 0);
		return ok(c, { summary: result.rows, total_cents: totalCents });
	}

	if (groupBy === 'day') {
		const result = await db.query<{ total_cents: number }>(
			`SELECT date_trunc('day', ce.created_at)::date::text AS day,
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

costsRoutes.post('/projects/:projectId/costs', async (c) => {
	const teamId = c.get('teamId') as string;
	const projectId = c.get('projectId') as string;
	const db = c.get('db');

	const body = await c.req.json<{
		member_id: string;
		amount_cents: number;
		task_id?: string;
		project_id?: string;
		description?: string;
	}>();

	if (!body.member_id || body.amount_cents == null || body.amount_cents <= 0) {
		return err(c, 'INVALID_REQUEST', 'member_id and positive amount_cents are required', 400);
	}

	// Spend is always recorded; budgets are enforced by windowed sums (services/budget.ts),
	// not a debit counter. Cost is project-scoped, so attribute it to the path project
	// unless the body names a specific one. After recording, reactively pause the agent if
	// this pushed it or its project over any window — mirroring the run-completion path.
	const costProjectId = body.project_id ?? projectId;
	const result = await db.query(
		`INSERT INTO cost_entries (member_id, task_id, project_id, amount_cents, description)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
		[
			body.member_id,
			body.task_id ?? null,
			costProjectId,
			body.amount_cents,
			body.description ?? '',
		],
	);

	broadcastChange(
		c,
		wsRoom.team(teamId),
		'cost_entries',
		'INSERT',
		result.rows[0] as Record<string, unknown>,
	);

	const block = await checkOverBudget(db, body.member_id, costProjectId);
	if (block) {
		await pauseAgentForBudget(db, body.member_id, teamId, block, c.get('wsManager'));
	}

	return ok(c, result.rows[0], 201);
});

/**
 * Project budget status: per-window spend vs. limit for the project and each of
 * its agents, with over-budget flags. Powers the Budgets page and the project
 * warning banner. `overBudget` for an agent is true when the agent itself or the
 * project breaches any window (matching the run gate); both component flags are
 * surfaced so the UI can explain why.
 */
costsRoutes.get('/projects/:projectId/budget-status', async (c) => {
	const teamId = c.get('teamId') as string;
	const projectId = c.get('projectId') as string;
	const db = c.get('db');

	const projectStatus = await getProjectBudgetStatus(db, projectId);

	// Month-to-date run count (one cost entry ≈ one run) powers the Budget hero's
	// "{N} runs · ≈ $/run" line. Same UTC month boundary the windowed sums use.
	const runsRow = await db.query<{ runs: number }>(
		`SELECT count(*)::int AS runs FROM cost_entries
		 WHERE project_id = $1 AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC')`,
		[projectId],
	);
	const runsThisMonth = runsRow.rows[0]?.runs ?? 0;

	// One grouped query for all agents (per-window spend + limits) rather than N+1.
	const agents = await db.query<{
		id: string;
		title: string;
		slug: string;
		runtime_status: string;
		icon_updated_at: string | null;
		daily_budget_cents: number;
		weekly_budget_cents: number;
		monthly_budget_cents: number;
		daily_spent: number;
		weekly_spent: number;
		monthly_spent: number;
	}>(
		`SELECT ma.id, ma.title, ma.slug, ma.runtime_status,
		        (SELECT ai.updated_at FROM agent_icons ai WHERE ai.member_id = ma.id) AS icon_updated_at,
		        ma.daily_budget_cents, ma.weekly_budget_cents, ma.monthly_budget_cents,
		        COALESCE(SUM(ce.amount_cents) FILTER (WHERE ce.created_at >= date_trunc('day',   now() AT TIME ZONE 'UTC')), 0)::int AS daily_spent,
		        COALESCE(SUM(ce.amount_cents) FILTER (WHERE ce.created_at >= date_trunc('week',  now() AT TIME ZONE 'UTC')), 0)::int AS weekly_spent,
		        COALESCE(SUM(ce.amount_cents) FILTER (WHERE ce.created_at >= date_trunc('month', now() AT TIME ZONE 'UTC')), 0)::int AS monthly_spent
		 FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 LEFT JOIN cost_entries ce ON ce.member_id = ma.id
		 WHERE m.team_id = $1
		 GROUP BY ma.id, ma.title, ma.slug, ma.runtime_status,
		          ma.daily_budget_cents, ma.weekly_budget_cents, ma.monthly_budget_cents
		 ORDER BY ma.title`,
		[teamId],
	);

	const masterKeyManager = c.get('masterKeyManager');
	const agentStatuses = await Promise.all(
		agents.rows.map(async (a) => {
			const status = toEntityBudgetStatus(
				{ daily: a.daily_spent, weekly: a.weekly_spent, monthly: a.monthly_spent },
				{
					daily_budget_cents: a.daily_budget_cents,
					weekly_budget_cents: a.weekly_budget_cents,
					monthly_budget_cents: a.monthly_budget_cents,
				},
			);
			return {
				agent_id: a.id,
				agent_title: a.title,
				agent_slug: a.slug,
				runtime_status: a.runtime_status,
				// The uploaded avatar (if any). The built-in CEO/Coach default is
				// resolved client-side from the slug; this only carries the upload.
				agent_icon_url: await signVersionedIconUrl(
					AGENT_ICON_URL,
					a.id,
					a.icon_updated_at,
					masterKeyManager,
				),
				daily: status.daily,
				weekly: status.weekly,
				monthly: status.monthly,
				agent_over_budget: status.overBudget,
				project_over_budget: projectStatus.overBudget,
				overBudget: status.overBudget || projectStatus.overBudget,
			};
		}),
	);

	return ok(c, { project: projectStatus, agents: agentStatuses, runsThisMonth });
});
