import { Hono } from 'hono';
import { buildCursorPage, encodeCursor, parseCursorPagination } from '../lib/pagination';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import {
	type BudgetLimits,
	getProjectBudgetStatus,
	toEntityBudgetStatus,
	USAGE_ENTRY_COLUMNS_SQL,
	USAGE_WINDOW_FLOOR_SQL,
	USAGE_WINDOW_SUMS_SQL,
} from '../services/budget';
import {
	parseUsageFilters,
	type UsageDaySplit,
	usageByAgent,
	usageByDay,
	usageTotals,
	usageWhere,
} from '../services/usage-read';

export const usageRoutes = new Hono<Env>();

/**
 * Usage reads are scoped to a single project (`ue.project_id`) - usage is
 * project/agent/credential-scoped, never team-scoped. `group_by=day` powers the
 * project total chart; `breakdown=agent` / `breakdown=adapter` add a per-day
 * series split for the stacked charts on the Budgets page. The queries are the
 * `get_usage` tool's, from `services/usage-read.ts`.
 */

const DAY_SPLIT_BY_BREAKDOWN: Record<string, UsageDaySplit> = {
	agent: 'agent',
	adapter: 'adapter',
};

usageRoutes.get('/projects/:projectId/usage', async (c) => {
	const db = c.get('db');
	const parsed = parseUsageFilters(c.get('projectId') as string, {
		agent_id: c.req.query('agent_id'),
		task_id: c.req.query('task_id'),
		from: c.req.query('from'),
		to: c.req.query('to'),
	});
	if ('error' in parsed) return err(c, 'INVALID_REQUEST', parsed.error, 400);
	const { filters } = parsed;
	const groupBy = c.req.query('group_by');

	if (groupBy === 'agent') {
		const rows = await usageByAgent(db, filters);
		return ok(c, { summary: rows, ...(await usageTotals(db, filters)) });
	}

	// The day series grows for as long as the project runs, so it pages by whole
	// days, newest first; `cursor` is the day the next page ends before. The totals
	// cover every matching entry, not the page.
	if (groupBy === 'day') {
		const split = DAY_SPLIT_BY_BREAKDOWN[c.req.query('breakdown') ?? ''] ?? 'none';
		const cursor = c.req.query('cursor') ?? null;
		if (cursor !== null && !/^\d{4}-\d{2}-\d{2}$/.test(cursor)) {
			return err(c, 'invalid_cursor', 'The pagination cursor is malformed.', 400);
		}
		const { limit } = parseCursorPagination(c);
		const [page, totals] = await Promise.all([
			usageByDay(db, filters, split, { limit, beforeDay: cursor }),
			usageTotals(db, filters),
		]);
		return ok(c, {
			summary: page.rows,
			next_cursor: page.nextBeforeDay,
			has_more: page.nextBeforeDay !== null,
			...totals,
		});
	}

	const { where, params } = usageWhere(filters);
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
		usageTotals(db, filters),
	]);
	const page = buildCursorPage(entries.rows, limit, (row) =>
		encodeCursor(new Date(row.created_at).toISOString(), row.id),
	);
	return ok(c, {
		entries: page.data,
		next_cursor: page.meta.next_cursor,
		has_more: page.meta.has_more,
		...totals,
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
