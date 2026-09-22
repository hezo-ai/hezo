import { Hono } from 'hono';
import { agentDisplayNameSql } from '../lib/agent-identity';
import { buildCursorPage, encodeCursor, parseCursorPagination } from '../lib/pagination';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import {
	type BudgetLimits,
	getProjectBudgetStatus,
	toEntityBudgetStatus,
	USAGE_ENTRY_COLUMNS_SQL,
	USAGE_TOKEN_SUMS_SQL,
	USAGE_WINDOW_FLOOR_SQL,
	USAGE_WINDOW_SUMS_SQL,
} from '../services/budget';

export const usageRoutes = new Hono<Env>();

/**
 * Usage reads are scoped to a single project (`ue.project_id`) - usage is
 * project/agent/credential-scoped, never team-scoped. `group_by=day` powers the
 * project total chart; `breakdown=agent` / `breakdown=adapter` add a per-day
 * series split for the stacked charts on the Budgets page.
 */

/** A grouped result's rows rolled up into the response's totals. */
function summaryTotals(
	rows: Array<{ input_tokens: number; output_tokens: number; total_tokens: number }>,
): { input_tokens: number; output_tokens: number; total_tokens: number } {
	return {
		input_tokens: rows.reduce((sum, r) => sum + r.input_tokens, 0),
		output_tokens: rows.reduce((sum, r) => sum + r.output_tokens, 0),
		total_tokens: rows.reduce((sum, r) => sum + r.total_tokens, 0),
	};
}

type TokenSumRow = { input_tokens: number; output_tokens: number; total_tokens: number };

usageRoutes.get('/projects/:projectId/usage', async (c) => {
	const projectId = c.get('projectId') as string;
	const db = c.get('db');
	const agentId = c.req.query('agent_id');
	const taskId = c.req.query('task_id');
	const from = c.req.query('from');
	const to = c.req.query('to');
	const groupBy = c.req.query('group_by');
	const breakdown = c.req.query('breakdown');

	const conditions: string[] = ['ue.project_id = $1'];
	const params: unknown[] = [projectId];

	if (agentId) {
		params.push(agentId);
		conditions.push(`ue.member_id = $${params.length}`);
	}
	if (taskId) {
		params.push(taskId);
		conditions.push(`ue.task_id = $${params.length}`);
	}
	if (from) {
		params.push(from);
		conditions.push(`ue.created_at >= $${params.length}`);
	}
	if (to) {
		params.push(to);
		conditions.push(`ue.created_at <= $${params.length}`);
	}

	const where = conditions.join(' AND ');

	if (groupBy === 'agent') {
		const result = await db.query<TokenSumRow>(
			`SELECT ue.member_id AS agent_id,
              COALESCE(ma.title, m.display_name) AS agent_title,
              ${agentDisplayNameSql('ma', 'm')} AS agent_name,
              ${USAGE_TOKEN_SUMS_SQL}
       FROM usage_entries ue
       LEFT JOIN members m ON m.id = ue.member_id
       LEFT JOIN member_agents ma ON ma.id = ue.member_id
       WHERE ${where}
       GROUP BY ue.member_id, ma.title, ma.human_name, m.display_name`,
			params,
		);
		return ok(c, { summary: result.rows, ...summaryTotals(result.rows) });
	}

	// The per-day buckets cast to `::date::text` (not bare `::date`) on purpose: PGlite
	// deserializes a Postgres `date` into a JS Date, which Hono's c.json() then renders
	// as a full ISO timestamp ("2024-01-15T00:00:00.000Z"). The chart parses `day` as a
	// date-only string, so the timestamp form breaks it ("Invalid Date"). `::text` keeps
	// it a plain "YYYY-MM-DD". Keep the cast on all three group_by=day queries below.
	if (groupBy === 'day' && breakdown === 'agent') {
		const result = await db.query<TokenSumRow>(
			`SELECT date_trunc('day', ue.created_at)::date::text AS day,
              ue.member_id AS agent_id,
              COALESCE(ma.title, m.display_name) AS agent_title,
              ${agentDisplayNameSql('ma', 'm')} AS agent_name,
              ${USAGE_TOKEN_SUMS_SQL}
       FROM usage_entries ue
       LEFT JOIN members m ON m.id = ue.member_id
       LEFT JOIN member_agents ma ON ma.id = ue.member_id
       WHERE ${where}
       GROUP BY day, ue.member_id, ma.title, ma.human_name, m.display_name
       ORDER BY day`,
			params,
		);
		return ok(c, { summary: result.rows, ...summaryTotals(result.rows) });
	}

	if (groupBy === 'day' && breakdown === 'adapter') {
		const result = await db.query<TokenSumRow>(
			`SELECT date_trunc('day', ue.created_at)::date::text AS day,
              ue.ai_provider_config_id,
              ue.provider,
              apc.label AS adapter_label,
              ${USAGE_TOKEN_SUMS_SQL}
       FROM usage_entries ue
       LEFT JOIN ai_provider_configs apc ON apc.id = ue.ai_provider_config_id
       WHERE ${where}
       GROUP BY day, ue.ai_provider_config_id, ue.provider, apc.label
       ORDER BY day`,
			params,
		);
		return ok(c, { summary: result.rows, ...summaryTotals(result.rows) });
	}

	if (groupBy === 'day') {
		const result = await db.query<TokenSumRow>(
			`SELECT date_trunc('day', ue.created_at)::date::text AS day,
              ${USAGE_TOKEN_SUMS_SQL}
       FROM usage_entries ue
       WHERE ${where}
       GROUP BY day ORDER BY day`,
			params,
		);
		return ok(c, { summary: result.rows, ...summaryTotals(result.rows) });
	}

	// Totals over every matching entry, and one page of the entries themselves,
	// newest first. The ledger only grows, so the entries page by keyset and the
	// totals come from the query rather than from the page.
	const { limit, cursor, invalidCursor } = parseCursorPagination(c);
	if (invalidCursor) {
		return err(c, 'invalid_cursor', 'The pagination cursor is malformed.', 400);
	}
	const pageParams = [...params];
	const pageConditions = [where];
	if (cursor) {
		pageParams.push(cursor.value, cursor.id);
		pageConditions.push(
			`(ue.created_at, ue.id) < ($${pageParams.length - 1}::timestamptz, $${pageParams.length}::uuid)`,
		);
	}
	pageParams.push(limit + 1);
	const [entries, totals] = await Promise.all([
		db.query<{ id: string; created_at: string | Date }>(
			`SELECT ${USAGE_ENTRY_COLUMNS_SQL} FROM usage_entries ue
			 WHERE ${pageConditions.join(' AND ')}
			 ORDER BY ue.created_at DESC, ue.id DESC LIMIT $${pageParams.length}`,
			pageParams,
		),
		db.query<TokenSumRow>(
			`SELECT ${USAGE_TOKEN_SUMS_SQL} FROM usage_entries ue WHERE ${where}`,
			params,
		),
	]);
	const page = buildCursorPage(entries.rows, limit, (row) =>
		encodeCursor(new Date(row.created_at).toISOString(), row.id),
	);
	return ok(c, {
		entries: page.data,
		next_cursor: page.meta.next_cursor,
		has_more: page.meta.has_more,
		...(totals.rows[0] ?? summaryTotals([])),
	});
});

/**
 * Project budget status: per-window usage vs. limit for the project and each of
 * its agents, with over-budget flags. Powers the Budgets page and the project
 * warning banner. `overBudget` for an agent is true when the agent itself or the
 * project breaches any window (matching the run gate); both component flags are
 * surfaced so the UI can explain why.
 */
usageRoutes.get('/projects/:projectId/budget-status', async (c) => {
	const teamId = c.get('teamId') as string;
	const projectId = c.get('projectId') as string;
	const db = c.get('db');

	const projectStatus = await getProjectBudgetStatus(db, projectId);

	// Month-to-date usage-entry count (one entry per run or chat turn) powers the
	// Budget hero's "{N} runs" line. Same UTC month boundary the windowed sums use.
	const runsRow = await db.query<{ runs: number }>(
		`SELECT count(*)::int AS runs FROM usage_entries
		 WHERE project_id = $1 AND created_at >= date_trunc('month', now(), 'UTC')`,
		[projectId],
	);
	const runsThisMonth = runsRow.rows[0]?.runs ?? 0;

	// One grouped query for all agents (per-window usage + limits) rather than N+1.
	// An agent's windows count its usage in every project, which is what the run
	// gate enforces its own budget against.
	const agents = await db.query<
		BudgetLimits & {
			id: string;
			title: string;
			slug: string;
			runtime_status: string;
			human_name: string | null;
			avatar_spec: unknown;
			daily: number;
			weekly: number;
			monthly: number;
		}
	>(
		`SELECT ma.id, ma.title, ma.slug, ma.human_name, ma.avatar_spec, ma.runtime_status,
		        ma.daily_budget_tokens, ma.weekly_budget_tokens, ma.monthly_budget_tokens,
		        ${USAGE_WINDOW_SUMS_SQL}
		 FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 LEFT JOIN usage_entries ue
		   ON ue.member_id = ma.id AND ue.created_at >= ${USAGE_WINDOW_FLOOR_SQL}
		 WHERE m.team_id = $1
		 GROUP BY ma.id, ma.title, ma.slug, ma.human_name, ma.avatar_spec, ma.runtime_status,
		          ma.daily_budget_tokens, ma.weekly_budget_tokens, ma.monthly_budget_tokens
		 ORDER BY ma.title`,
		[teamId],
	);

	const agentStatuses = agents.rows.map((a) => {
		const status = toEntityBudgetStatus(a, a);
		return {
			agent_id: a.id,
			agent_title: a.title,
			agent_slug: a.slug,
			runtime_status: a.runtime_status,
			agent_name: a.human_name,
			// The agent's sprite is drawn client-side from this; the built-in
			// CEO/Coach portraits resolve from the slug.
			agent_avatar_spec: a.avatar_spec,
			daily: status.daily,
			weekly: status.weekly,
			monthly: status.monthly,
			agent_over_budget: status.overBudget,
			project_over_budget: projectStatus.overBudget,
			overBudget: status.overBudget || projectStatus.overBudget,
		};
	});

	return ok(c, { project: projectStatus, agents: agentStatuses, runsThisMonth });
});
