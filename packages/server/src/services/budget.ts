import {
	type AiProvider,
	BudgetPeriod,
	BudgetResource,
	type BudgetWindowsContainerSeconds,
	CONTAINER_HOURS_BUDGET_FIELDS,
	type ContainerHoursWindowStatus,
	type ProjectContainerHoursBudget,
	wsRoom,
} from '@hezo/shared';
import type { Db } from '../db/database';
import { BUDGET_USAGE_COUNTED_FROM_META_KEY } from '../db/migrations/code/081_token_budgets';
import { broadcastRowChange } from '../lib/broadcast';
import { utcWindowStartSql } from '../lib/sql';
import { projectBudgetWindowSeconds } from './container-hours';
import type { WebSocketManager } from './ws';

/**
 * Budget enforcement - the single source of truth for agent and project usage.
 *
 * Usage is computed on demand by summing `usage_entries` tokens over UTC calendar
 * windows (start-of-day / start-of-week (ISO Monday) / start-of-month), so there
 * is no running counter to reset. Only usage from the upgrade that made budgets
 * count tokens counts: before it, a subscription run counted against no budget,
 * and counting it now would pause agents for spend no budget ever measured. A budget counts everything a run sent and
 * received: input, cached input included, plus output. Limits live on
 * `member_agents` and `projects` as `daily_/weekly_/monthly_budget_tokens`; a
 * limit of 0 means unlimited for that window. A run is blocked when the agent OR
 * its project breaches ANY window.
 *
 * A project also carries an **hours budget**, `daily_/weekly_/monthly_budget_container_seconds`,
 * summed from the container-uptime ledger rather than from `usage_entries`
 * (`container-hours.ts`). It is checked by the same gate, after the token
 * budgets, so every path that already stops for tokens - the pre-run gate, the
 * reactive pause, the chat turn, the resume sweep - stops for hours too, and the
 * block says which it was.
 *
 * Every run and chat turn records its tokens through {@link recordUsage}, however
 * its credential is billed: a subscription spends an allowance as surely as an
 * API key spends money, and a budget that skipped it measured nothing on an
 * instance running on one. Reads here back the pre-run gate (`job-manager.ts`),
 * the reactive pause, and the budget-status API (`routes/usage.ts`).
 */

/** Tokens counted within each UTC calendar window. */
export interface WindowUsage {
	daily: number;
	weekly: number;
	monthly: number;
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

const ZERO_USAGE: WindowUsage = { daily: 0, weekly: 0, monthly: 0 };

/** No limit in any window: what an entity with nothing configured is checked against. */
export const NO_LIMITS: BudgetLimits = {
	daily_budget_tokens: 0,
	weekly_budget_tokens: 0,
	monthly_budget_tokens: 0,
};

/**
 * SQL for the three UTC window sums over `usage_entries`, aliased `ue`, which the
 * caller must bound with {@link USAGE_WINDOW_FLOOR_SQL}. {@link utcWindowStartSql}
 * truncates in UTC whatever the session time zone. `::float8` keeps
 * each a JSON number: a sum of int8 is numeric, which comes back as a string,
 * and a double holds every whole token count below 2^53 exactly.
 */
export const USAGE_WINDOW_SUMS_SQL = `
	COALESCE(SUM(ue.input_tokens + ue.output_tokens) FILTER (WHERE ue.created_at >= ${utcWindowStartSql("'day'")}), 0)::float8 AS daily,
	COALESCE(SUM(ue.input_tokens + ue.output_tokens) FILTER (WHERE ue.created_at >= ${utcWindowStartSql("'week'")}), 0)::float8 AS weekly,
	COALESCE(SUM(ue.input_tokens + ue.output_tokens) FILTER (WHERE ue.created_at >= ${utcWindowStartSql("'month'")}), 0)::float8 AS monthly`;

/**
 * The earliest `usage_entries.created_at` any window sum reads: the start of the
 * longer window (an ISO week can start in the previous month), or the instant
 * budgets began counting tokens if that is later. A lower bound on the scan, so
 * the `(member_id, created_at)` and `(project_id, created_at)` indexes range-scan
 * this month instead of an entity's whole history.
 */
export const USAGE_WINDOW_FLOOR_SQL = `GREATEST(
	LEAST(${utcWindowStartSql("'week'")}, ${utcWindowStartSql("'month'")}),
	COALESCE((SELECT value::timestamptz FROM system_meta WHERE key = '${BUDGET_USAGE_COUNTED_FROM_META_KEY}'), '-infinity'))`;

/** Input, output and total token sums over `usage_entries`, aliased `ue`, as JSON numbers. */
export const USAGE_TOKEN_SUMS_SQL = `COALESCE(SUM(ue.input_tokens), 0)::float8 AS input_tokens,
	COALESCE(SUM(ue.output_tokens), 0)::float8 AS output_tokens,
	COALESCE(SUM(ue.input_tokens + ue.output_tokens), 0)::float8 AS total_tokens`;

/**
 * Sum usage over the three UTC windows for a single entity column. `column` is
 * the trusted `usage_entries` filter column (`member_id` or `project_id`); it is
 * never derived from user input.
 */
async function getUsageByColumn(
	db: Db,
	column: 'member_id' | 'project_id',
	id: string,
): Promise<WindowUsage> {
	const res = await db.query<WindowUsage>(
		`SELECT ${USAGE_WINDOW_SUMS_SQL} FROM usage_entries ue
		  WHERE ue.${column} = $1 AND ue.created_at >= ${USAGE_WINDOW_FLOOR_SQL}`,
		[id],
	);
	return res.rows[0] ?? ZERO_USAGE;
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

/** Where each entity keeps its limits, and which ledger column is its usage. */
const BUDGET_ENTITIES = {
	agent: { table: 'member_agents', usageColumn: 'member_id' },
	project: { table: 'projects', usageColumn: 'project_id' },
} as const;

type BudgetEntity = keyof typeof BUDGET_ENTITIES;

async function readLimits(db: Db, entity: BudgetEntity, id: string): Promise<BudgetLimits> {
	const res = await db.query<BudgetLimits>(
		`SELECT ${BUDGET_LIMIT_COLUMNS} FROM ${BUDGET_ENTITIES[entity].table} WHERE id = $1`,
		[id],
	);
	return res.rows[0] ?? NO_LIMITS;
}

/** An entity's usage against its limits, for display. */
async function entityBudgetStatus(
	db: Db,
	entity: BudgetEntity,
	id: string,
): Promise<EntityBudgetStatus> {
	const [usage, limits] = await Promise.all([
		getUsageByColumn(db, BUDGET_ENTITIES[entity].usageColumn, id),
		readLimits(db, entity, id),
	]);
	return toEntityBudgetStatus(usage, limits);
}

export function getAgentBudgetStatus(db: Db, memberId: string): Promise<EntityBudgetStatus> {
	return entityBudgetStatus(db, 'agent', memberId);
}

export function getProjectBudgetStatus(db: Db, projectId: string): Promise<EntityBudgetStatus> {
	return entityBudgetStatus(db, 'project', projectId);
}

/** Which entity and window first blocks a run, with what it used against what it may. */
export interface OverBudgetBlock {
	scope: 'agent' | 'project';
	period: BudgetPeriod;
	/** What the budget counts. An hours block is always project-scoped. */
	resource: BudgetResource;
	/** Used so far in the window, in the resource's unit: tokens, or container-seconds. */
	used: number;
	/** The window's limit, in the same unit. */
	limit: number;
}

/** The three windows, used against limit, in whatever unit the budget counts. */
interface WindowUse {
	daily: { used: number; limit: number };
	weekly: { used: number; limit: number };
	monthly: { used: number; limit: number };
}

/** The windows in the order a block is reported: the shortest one that binds. */
const WINDOW_ORDER: readonly { period: BudgetPeriod; key: keyof WindowUse }[] = [
	{ period: BudgetPeriod.Daily, key: 'daily' },
	{ period: BudgetPeriod.Weekly, key: 'weekly' },
	{ period: BudgetPeriod.Monthly, key: 'monthly' },
];

/** A window is over budget only when a positive limit is met or exceeded. */
function isOver(window: { used: number; limit: number }): boolean {
	return window.limit > 0 && window.used >= window.limit;
}

function toBlock(
	scope: OverBudgetBlock['scope'],
	resource: BudgetResource,
	use: WindowUse,
): OverBudgetBlock | null {
	for (const { period, key } of WINDOW_ORDER) {
		const window = use[key];
		if (isOver(window)) return { scope, period, resource, used: window.used, limit: window.limit };
	}
	return null;
}

/**
 * The gate primitive. Returns the first blocking window across the agent's
 * tokens, then the project's tokens, then the project's container-hours, or null
 * when all are within budget. When `projectId` is omitted (e.g. a task-less
 * wakeup whose project is not yet resolved) only the agent is checked.
 */
export async function checkOverBudget(
	db: Db,
	memberId: string,
	projectId: string | null,
): Promise<OverBudgetBlock | null> {
	const agentBlock = await entityBlock(
		db,
		'agent',
		memberId,
		await readLimits(db, 'agent', memberId),
	);
	if (agentBlock) return agentBlock;
	if (!projectId) return null;
	const limits = await readProjectLimits(db, projectId);
	if (!limits) return null;
	return (await entityBlock(db, 'project', projectId, limits)) ?? hoursBlock(db, projectId, limits);
}

/**
 * The token window that blocks an entity, or null. The sums are skipped when
 * every window is unlimited, which is the default: nothing can be over, so a
 * gate run per dispatch and per run completion pays one primary-key read.
 */
async function entityBlock(
	db: Db,
	entity: BudgetEntity,
	id: string,
	limits: BudgetLimits,
): Promise<OverBudgetBlock | null> {
	const unlimited =
		Number(limits.daily_budget_tokens) <= 0 &&
		Number(limits.weekly_budget_tokens) <= 0 &&
		Number(limits.monthly_budget_tokens) <= 0;
	if (unlimited) return null;
	const usage = await getUsageByColumn(db, BUDGET_ENTITIES[entity].usageColumn, id);
	return toBlock(entity, BudgetResource.Tokens, {
		daily: { used: Number(usage.daily), limit: Number(limits.daily_budget_tokens) },
		weekly: { used: Number(usage.weekly), limit: Number(limits.weekly_budget_tokens) },
		monthly: { used: Number(usage.monthly), limit: Number(limits.monthly_budget_tokens) },
	});
}

/** A project's hours limits, as JSON numbers. */
function hoursLimits(limits: BudgetWindowsContainerSeconds): BudgetWindowsContainerSeconds {
	return {
		daily_budget_container_seconds: Number(limits.daily_budget_container_seconds),
		weekly_budget_container_seconds: Number(limits.weekly_budget_container_seconds),
		monthly_budget_container_seconds: Number(limits.monthly_budget_container_seconds),
	};
}

/** True when a project set no hours limit in any window - the default. */
function noHoursLimit(limits: BudgetWindowsContainerSeconds): boolean {
	return CONTAINER_HOURS_BUDGET_FIELDS.every((field) => Number(limits[field]) <= 0);
}

/**
 * The hours window that blocks a project, or null. Like the token check, the
 * ledger is never read for a project with no hours limit.
 */
async function hoursBlock(
	db: Db,
	projectId: string,
	stored: BudgetWindowsContainerSeconds,
): Promise<OverBudgetBlock | null> {
	const limits = hoursLimits(stored);
	if (noHoursLimit(limits)) return null;
	const used = await projectBudgetWindowSeconds(db, projectId);
	return toBlock('project', BudgetResource.ContainerHours, {
		daily: { used: used.daily, limit: limits.daily_budget_container_seconds },
		weekly: { used: used.weekly, limit: limits.weekly_budget_container_seconds },
		monthly: { used: used.monthly, limit: limits.monthly_budget_container_seconds },
	});
}

/**
 * Whether the gate would stop this project for its hours right now - the cheap
 * question the project banner asks on every page, so it reads the ledger only
 * when the project set an hours limit.
 */
export async function isProjectOverHoursBudget(db: Db, projectId: string): Promise<boolean> {
	const limits = await readProjectLimits(db, projectId);
	return limits !== null && (await hoursBlock(db, projectId, limits)) !== null;
}

/** The hours-budget columns of `projects`. */
const HOURS_LIMIT_COLUMNS = CONTAINER_HOURS_BUDGET_FIELDS.join(', ');

/** A project's token and hours limits in one primary-key read, or null when it is gone. */
async function readProjectLimits(
	db: Db,
	projectId: string,
): Promise<(BudgetLimits & BudgetWindowsContainerSeconds) | null> {
	const res = await db.query<BudgetLimits & BudgetWindowsContainerSeconds>(
		`SELECT ${BUDGET_LIMIT_COLUMNS}, ${HOURS_LIMIT_COLUMNS} FROM projects WHERE id = $1`,
		[projectId],
	);
	return res.rows[0] ?? null;
}

function hoursWindowStatus(usedSeconds: number, limitSeconds: number): ContainerHoursWindowStatus {
	return {
		used_seconds: usedSeconds,
		limit_seconds: limitSeconds,
		over_budget: isOver({ used: usedSeconds, limit: limitSeconds }),
	};
}

/**
 * A project's hours budget against what its containers used, for display.
 *
 * Read from the same sums and the same windows as the gate, so a page that says
 * a window has room can never sit beside a gate that has closed it.
 */
export async function getProjectHoursBudgetStatus(
	db: Db,
	projectId: string,
): Promise<ProjectContainerHoursBudget> {
	const res = await db.query<BudgetWindowsContainerSeconds>(
		`SELECT ${HOURS_LIMIT_COLUMNS} FROM projects WHERE id = $1`,
		[projectId],
	);
	const limits = hoursLimits(
		res.rows[0] ?? {
			daily_budget_container_seconds: 0,
			weekly_budget_container_seconds: 0,
			monthly_budget_container_seconds: 0,
		},
	);
	const used = await projectBudgetWindowSeconds(db, projectId);
	const daily = hoursWindowStatus(used.daily, limits.daily_budget_container_seconds);
	const weekly = hoursWindowStatus(used.weekly, limits.weekly_budget_container_seconds);
	const monthly = hoursWindowStatus(used.monthly, limits.monthly_budget_container_seconds);
	return {
		daily,
		weekly,
		monthly,
		over_budget: daily.over_budget || weekly.over_budget || monthly.over_budget,
	};
}

/**
 * Record a run's or chat turn's tokens as a single `usage_entries` row - the
 * canonical usage event - and tell the open pages of the team that owns it, so
 * the Budget page refreshes. No-op when nothing was used. Returns the inserted
 * row, or null on a no-op.
 */
export async function recordUsage(
	db: Db,
	broadcast: { wsManager: WebSocketManager | undefined; teamId: string },
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
		/**
		 * When the work happened, where that is not now: a run reconciled after a
		 * restart is counted at its own start, so an upgrade's counted-from floor
		 * keeps pre-upgrade work out of the new budgets.
		 */
		occurredAt?: string | Date | null;
	},
): Promise<Record<string, unknown> | null> {
	if (entry.inputTokens <= 0 && entry.outputTokens <= 0) return null;
	const res = await db.query<Record<string, unknown>>(
		`INSERT INTO usage_entries
		   (member_id, task_id, project_id, input_tokens, output_tokens, description,
		    ai_provider_config_id, provider, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::ai_provider, COALESCE($9::timestamptz, now()))
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
			entry.occurredAt ?? null,
		],
	);
	const row = res.rows[0] ?? null;
	if (row) {
		broadcastRowChange(
			broadcast.wsManager,
			wsRoom.team(broadcast.teamId),
			'usage_entries',
			'INSERT',
			row,
		);
	}
	return row;
}

/** A `usage_entries` row as the API returns it. */
export const USAGE_ENTRY_COLUMNS_SQL = `id, member_id, task_id, project_id, input_tokens,
	output_tokens, description, ai_provider_config_id, provider, created_at`;
