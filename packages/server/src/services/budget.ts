import { type AiProvider, BudgetPeriod } from '@hezo/shared';
import type { Db } from '../db/database';

/**
 * Budget enforcement - the single source of truth for agent and project usage.
 *
 * Usage is computed on demand by summing `usage_entries` tokens over rolling UTC
 * windows (start-of-day / start-of-week (ISO Monday) / start-of-month), so there
 * is no running counter to reset. A budget counts everything a run sent and
 * received: input, cached input included, plus output. Limits live on
 * `member_agents` and `projects` as `daily_/weekly_/monthly_budget_tokens`; a
 * limit of 0 means unlimited for that window. A run is blocked when the agent OR
 * its project breaches ANY window.
 *
 * Every run and chat turn records its tokens through {@link recordUsage}, however
 * its credential is billed: a subscription spends an allowance as surely as an
 * API key spends money, and a budget that skipped it measured nothing on an
 * instance running on one. Reads here back the pre-run gate (`job-manager.ts`),
 * the reactive pause, and the budget-status API (`routes/usage.ts`).
 */

/** Tokens counted within each UTC calendar window, plus all-time. */
export interface WindowUsage {
	daily: number;
	weekly: number;
	monthly: number;
	allTime: number;
}

/** Usage vs. limit for a single window. `overBudget` requires a positive limit. */
export interface WindowStatus {
	usedTokens: number;
	limitTokens: number;
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
	daily_budget_tokens: number;
	weekly_budget_tokens: number;
	monthly_budget_tokens: number;
}

const ZERO_USAGE: WindowUsage = { daily: 0, weekly: 0, monthly: 0, allTime: 0 };

const NO_LIMITS: BudgetLimits = {
	daily_budget_tokens: 0,
	weekly_budget_tokens: 0,
	monthly_budget_tokens: 0,
};

/**
 * SQL for the three UTC window sums and all-time over `usage_entries`, aliased
 * `ue`. `::float8` keeps each a JSON number: a sum of int8 is numeric, which
 * comes back as a string, and a double holds every whole token count below 2^53
 * exactly.
 */
export const USAGE_WINDOW_SUMS_SQL = `
	COALESCE(SUM(ue.input_tokens + ue.output_tokens) FILTER (WHERE ue.created_at >= date_trunc('day',   now() AT TIME ZONE 'UTC')), 0)::float8 AS daily,
	COALESCE(SUM(ue.input_tokens + ue.output_tokens) FILTER (WHERE ue.created_at >= date_trunc('week',  now() AT TIME ZONE 'UTC')), 0)::float8 AS weekly,
	COALESCE(SUM(ue.input_tokens + ue.output_tokens) FILTER (WHERE ue.created_at >= date_trunc('month', now() AT TIME ZONE 'UTC')), 0)::float8 AS monthly,
	COALESCE(SUM(ue.input_tokens + ue.output_tokens), 0)::float8 AS "allTime"`;

/** Input, output and total token sums over `usage_entries`, aliased `ue`, as JSON numbers. */
export const USAGE_TOKEN_SUMS_SQL = `COALESCE(SUM(ue.input_tokens), 0)::float8 AS input_tokens,
	COALESCE(SUM(ue.output_tokens), 0)::float8 AS output_tokens,
	COALESCE(SUM(ue.input_tokens + ue.output_tokens), 0)::float8 AS total_tokens`;

/**
 * Sum usage over the three UTC windows (and all-time) for a single entity column.
 * `column` is the trusted `usage_entries` filter column (`member_id` or
 * `project_id`); it is never derived from user input.
 */
async function getUsageByColumn(
	db: Db,
	column: 'member_id' | 'project_id',
	id: string,
): Promise<WindowUsage> {
	const res = await db.query<WindowUsage>(
		`SELECT ${USAGE_WINDOW_SUMS_SQL} FROM usage_entries ue WHERE ue.${column} = $1`,
		[id],
	);
	return res.rows[0] ?? ZERO_USAGE;
}

export function getAgentUsage(db: Db, memberId: string): Promise<WindowUsage> {
	return getUsageByColumn(db, 'member_id', memberId);
}

export function getProjectUsage(db: Db, projectId: string): Promise<WindowUsage> {
	return getUsageByColumn(db, 'project_id', projectId);
}

/** A window is over budget only when a positive limit is met or exceeded. */
function windowStatus(usedTokens: number, limitTokens: number): WindowStatus {
	return { usedTokens, limitTokens, overBudget: limitTokens > 0 && usedTokens >= limitTokens };
}

/** Build per-window status from already-fetched usage + limits (no DB access). */
export function toEntityBudgetStatus(
	usage: Pick<WindowUsage, 'daily' | 'weekly' | 'monthly'>,
	limits: BudgetLimits,
): EntityBudgetStatus {
	const daily = windowStatus(usage.daily, limits.daily_budget_tokens);
	const weekly = windowStatus(usage.weekly, limits.weekly_budget_tokens);
	const monthly = windowStatus(usage.monthly, limits.monthly_budget_tokens);
	return {
		daily,
		weekly,
		monthly,
		overBudget: daily.overBudget || weekly.overBudget || monthly.overBudget,
	};
}

/** The budget limit columns of `member_agents` and `projects`. */
const BUDGET_LIMIT_COLUMNS = 'daily_budget_tokens, weekly_budget_tokens, monthly_budget_tokens';

export async function getAgentBudgetStatus(db: Db, memberId: string): Promise<EntityBudgetStatus> {
	const [usage, limitsRes] = await Promise.all([
		getAgentUsage(db, memberId),
		db.query<BudgetLimits>(`SELECT ${BUDGET_LIMIT_COLUMNS} FROM member_agents WHERE id = $1`, [
			memberId,
		]),
	]);
	return toEntityBudgetStatus(usage, limitsRes.rows[0] ?? NO_LIMITS);
}

export async function getProjectBudgetStatus(
	db: Db,
	projectId: string,
): Promise<EntityBudgetStatus> {
	const [usage, limitsRes] = await Promise.all([
		getProjectUsage(db, projectId),
		db.query<BudgetLimits>(`SELECT ${BUDGET_LIMIT_COLUMNS} FROM projects WHERE id = $1`, [
			projectId,
		]),
	]);
	return toEntityBudgetStatus(usage, limitsRes.rows[0] ?? NO_LIMITS);
}

/** Which entity and window first blocks a run, with what it used against what it may. */
export interface OverBudgetBlock {
	scope: 'agent' | 'project';
	period: BudgetPeriod;
	usedTokens: number;
	limitTokens: number;
}

function firstBlockingWindow(
	status: EntityBudgetStatus,
): { period: BudgetPeriod; window: WindowStatus } | null {
	if (status.daily.overBudget) return { period: BudgetPeriod.Daily, window: status.daily };
	if (status.weekly.overBudget) return { period: BudgetPeriod.Weekly, window: status.weekly };
	if (status.monthly.overBudget) return { period: BudgetPeriod.Monthly, window: status.monthly };
	return null;
}

function toBlock(
	scope: OverBudgetBlock['scope'],
	status: EntityBudgetStatus,
): OverBudgetBlock | null {
	const blocking = firstBlockingWindow(status);
	if (!blocking) return null;
	return {
		scope,
		period: blocking.period,
		usedTokens: blocking.window.usedTokens,
		limitTokens: blocking.window.limitTokens,
	};
}

/**
 * The gate primitive. Returns the first blocking window across the agent then
 * the project, or null when both are within budget. When `projectId` is omitted
 * (e.g. a task-less wakeup whose project is not yet resolved) only the agent is
 * checked.
 */
export async function checkOverBudget(
	db: Db,
	memberId: string,
	projectId: string | null,
): Promise<OverBudgetBlock | null> {
	const agentBlock = toBlock('agent', await getAgentBudgetStatus(db, memberId));
	if (agentBlock) return agentBlock;
	if (!projectId) return null;
	return toBlock('project', await getProjectBudgetStatus(db, projectId));
}

/**
 * Record a run's or chat turn's tokens as a single `usage_entries` row - the
 * canonical usage event. No-op when nothing was used. Returns the inserted row
 * (or null on no-op) so callers can broadcast the change.
 */
export async function recordUsage(
	db: Db,
	entry: {
		memberId: string;
		taskId: string | null;
		projectId: string | null;
		inputTokens: number;
		outputTokens: number;
		description: string;
		/** The credential that did the work, for the per-credential breakdown. */
		aiProviderConfigId?: string | null;
		provider?: AiProvider | null;
	},
): Promise<Record<string, unknown> | null> {
	if (entry.inputTokens <= 0 && entry.outputTokens <= 0) return null;
	const res = await db.query<Record<string, unknown>>(
		`INSERT INTO usage_entries
		   (member_id, task_id, project_id, input_tokens, output_tokens, description,
		    ai_provider_config_id, provider)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::ai_provider)
		 RETURNING ${USAGE_ENTRY_COLUMNS_SQL}`,
		[
			entry.memberId,
			entry.taskId,
			entry.projectId,
			Math.max(0, Math.round(entry.inputTokens)),
			Math.max(0, Math.round(entry.outputTokens)),
			entry.description,
			entry.aiProviderConfigId ?? null,
			entry.provider ?? null,
		],
	);
	return res.rows[0] ?? null;
}

/** A `usage_entries` row as the API returns it. */
export const USAGE_ENTRY_COLUMNS_SQL = `id, member_id, task_id, project_id, input_tokens,
	output_tokens, description, ai_provider_config_id, provider, created_at`;
