import type { PGlite } from '@electric-sql/pglite';
import { BudgetPeriod } from '@hezo/shared';

/**
 * Budget enforcement — the single source of truth for agent/project spend.
 *
 * Spend is computed on demand by summing `cost_entries.amount_cents` over rolling
 * UTC windows (start-of-day / start-of-week (ISO Monday) / start-of-month), so
 * there is no running counter to reset. Limits live on `member_agents` and
 * `projects` as `daily_/weekly_/monthly_budget_cents`; a limit of 0 means
 * unlimited for that window. A run is blocked when the agent OR its project
 * breaches ANY window.
 *
 * The canonical cost event is run completion (`agent-runner.ts:updateHeartbeatRun`),
 * which inserts one `cost_entries` row per run via `recordRunCost`. Reads here
 * back the pre-run gate (`job-manager.ts`), the reactive pause, and the
 * budget-status API (`routes/costs.ts`).
 */

/** Cents spent within each rolling window. */
export interface WindowSpend {
	daily: number;
	weekly: number;
	monthly: number;
}

/** Spend vs. limit for a single window. `overBudget` requires a positive limit. */
export interface WindowStatus {
	spentCents: number;
	limitCents: number;
	overBudget: boolean;
}

/** Per-window status for one entity (agent or project) plus an aggregate flag. */
export interface EntityBudgetStatus {
	daily: WindowStatus;
	weekly: WindowStatus;
	monthly: WindowStatus;
	/** True when any window is over budget. */
	overBudget: boolean;
}

/** The window limits configured on an agent or project. */
export interface BudgetLimits {
	daily_budget_cents: number;
	weekly_budget_cents: number;
	monthly_budget_cents: number;
}

const ZERO_SPEND: WindowSpend = { daily: 0, weekly: 0, monthly: 0 };

/**
 * Sum spend over the three UTC windows for a single entity column. `column` is
 * the trusted `cost_entries` filter column (`member_id` or `project_id`); it is
 * never derived from user input.
 */
async function getSpendByColumn(
	db: PGlite,
	column: 'member_id' | 'project_id',
	id: string,
): Promise<WindowSpend> {
	const res = await db.query<WindowSpend>(
		`SELECT
		   COALESCE(SUM(amount_cents) FILTER (WHERE created_at >= date_trunc('day',   now() AT TIME ZONE 'UTC')), 0)::int AS daily,
		   COALESCE(SUM(amount_cents) FILTER (WHERE created_at >= date_trunc('week',  now() AT TIME ZONE 'UTC')), 0)::int AS weekly,
		   COALESCE(SUM(amount_cents) FILTER (WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'UTC')), 0)::int AS monthly
		 FROM cost_entries
		 WHERE ${column} = $1`,
		[id],
	);
	return res.rows[0] ?? ZERO_SPEND;
}

export function getAgentSpend(db: PGlite, memberId: string): Promise<WindowSpend> {
	return getSpendByColumn(db, 'member_id', memberId);
}

export function getProjectSpend(db: PGlite, projectId: string): Promise<WindowSpend> {
	return getSpendByColumn(db, 'project_id', projectId);
}

/** A window is over budget only when a positive limit is met or exceeded. */
function windowStatus(spentCents: number, limitCents: number): WindowStatus {
	return { spentCents, limitCents, overBudget: limitCents > 0 && spentCents >= limitCents };
}

function buildStatus(spend: WindowSpend, limits: BudgetLimits): EntityBudgetStatus {
	const daily = windowStatus(spend.daily, limits.daily_budget_cents);
	const weekly = windowStatus(spend.weekly, limits.weekly_budget_cents);
	const monthly = windowStatus(spend.monthly, limits.monthly_budget_cents);
	return {
		daily,
		weekly,
		monthly,
		overBudget: daily.overBudget || weekly.overBudget || monthly.overBudget,
	};
}

export async function getAgentBudgetStatus(
	db: PGlite,
	memberId: string,
): Promise<EntityBudgetStatus> {
	const [spend, limitsRes] = await Promise.all([
		getAgentSpend(db, memberId),
		db.query<BudgetLimits>(
			`SELECT daily_budget_cents, weekly_budget_cents, monthly_budget_cents
			 FROM member_agents WHERE id = $1`,
			[memberId],
		),
	]);
	const limits = limitsRes.rows[0] ?? {
		daily_budget_cents: 0,
		weekly_budget_cents: 0,
		monthly_budget_cents: 0,
	};
	return buildStatus(spend, limits);
}

export async function getProjectBudgetStatus(
	db: PGlite,
	projectId: string,
): Promise<EntityBudgetStatus> {
	const [spend, limitsRes] = await Promise.all([
		getProjectSpend(db, projectId),
		db.query<BudgetLimits>(
			`SELECT daily_budget_cents, weekly_budget_cents, monthly_budget_cents
			 FROM projects WHERE id = $1`,
			[projectId],
		),
	]);
	const limits = limitsRes.rows[0] ?? {
		daily_budget_cents: 0,
		weekly_budget_cents: 0,
		monthly_budget_cents: 0,
	};
	return buildStatus(spend, limits);
}

/** Which entity/window first blocks a run, or null when within budget. */
export interface OverBudgetBlock {
	scope: 'agent' | 'project';
	period: BudgetPeriod;
}

function firstBlockingPeriod(status: EntityBudgetStatus): BudgetPeriod | null {
	if (status.daily.overBudget) return BudgetPeriod.Daily;
	if (status.weekly.overBudget) return BudgetPeriod.Weekly;
	if (status.monthly.overBudget) return BudgetPeriod.Monthly;
	return null;
}

/**
 * The gate primitive. Returns the first blocking window across the agent then
 * the project, or null when both are within budget. When `projectId` is omitted
 * (e.g. a task-less wakeup whose project is not yet resolved) only the agent is
 * checked.
 */
export async function checkOverBudget(
	db: PGlite,
	memberId: string,
	projectId: string | null,
): Promise<OverBudgetBlock | null> {
	const agentStatus = await getAgentBudgetStatus(db, memberId);
	const agentPeriod = firstBlockingPeriod(agentStatus);
	if (agentPeriod) return { scope: 'agent', period: agentPeriod };

	if (projectId) {
		const projectStatus = await getProjectBudgetStatus(db, projectId);
		const projectPeriod = firstBlockingPeriod(projectStatus);
		if (projectPeriod) return { scope: 'project', period: projectPeriod };
	}
	return null;
}

/**
 * Record a run's cost as a single `cost_entries` row — the canonical cost event.
 * No-op for non-positive amounts. Returns the inserted row (or null on no-op) so
 * callers can broadcast the change.
 */
export async function recordRunCost(
	db: PGlite,
	entry: {
		teamId: string;
		memberId: string;
		taskId: string | null;
		projectId: string | null;
		amountCents: number;
		description: string;
	},
): Promise<Record<string, unknown> | null> {
	if (entry.amountCents <= 0) return null;
	const res = await db.query<Record<string, unknown>>(
		`INSERT INTO cost_entries (team_id, member_id, task_id, project_id, amount_cents, description)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 RETURNING *`,
		[
			entry.teamId,
			entry.memberId,
			entry.taskId,
			entry.projectId,
			entry.amountCents,
			entry.description,
		],
	);
	return res.rows[0] ?? null;
}
