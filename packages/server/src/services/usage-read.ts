import type { Db } from '../db/database';
import { agentDisplayNameSql } from '../lib/agent-identity';
import { isUuid } from '../lib/resolve';
import { USAGE_TOKEN_SUMS_SQL } from './budget';

/**
 * The project usage reads, shared by `GET /usage` and the `get_usage` tool so the
 * two return the same columns for the same question.
 */

/** A token sum as every usage read reports it. */
export interface UsageTotals {
	input_tokens: number;
	output_tokens: number;
	total_tokens: number;
}

/** What a usage read may be narrowed by. Ids are uuids; `from`/`to` are dates or instants. */
export interface UsageFilters {
	projectId: string;
	agentId?: string;
	taskId?: string;
	from?: string;
	to?: string;
}

/**
 * Validate a caller's filters: an id that is not a uuid, or a bound that is not a
 * date, would otherwise reach a typed comparison and fail the query.
 */
export function parseUsageFilters(
	projectId: string,
	raw: { agent_id?: string; task_id?: string; from?: string; to?: string },
): { error: string } | { filters: UsageFilters } {
	for (const [name, value] of [
		['agent_id', raw.agent_id],
		['task_id', raw.task_id],
	] as const) {
		if (value !== undefined && !isUuid(value)) return { error: `${name} must be a uuid` };
	}
	for (const [name, value] of [
		['from', raw.from],
		['to', raw.to],
	] as const) {
		if (value !== undefined && Number.isNaN(Date.parse(value))) {
			return { error: `${name} must be a date or a timestamp` };
		}
	}
	return {
		filters: {
			projectId,
			agentId: raw.agent_id,
			taskId: raw.task_id,
			from: raw.from,
			to: raw.to,
		},
	};
}

/** The WHERE clause and its parameters for `filters`, over `usage_entries ue`. */
export function usageWhere(filters: UsageFilters): { where: string; params: unknown[] } {
	const conditions = ['ue.project_id = $1'];
	const params: unknown[] = [filters.projectId];
	const add = (sql: (placeholder: string) => string, value: unknown) => {
		params.push(value);
		conditions.push(sql(`$${params.length}`));
	};
	if (filters.agentId) add((p) => `ue.member_id = ${p}`, filters.agentId);
	if (filters.taskId) add((p) => `ue.task_id = ${p}`, filters.taskId);
	if (filters.from) add((p) => `ue.created_at >= ${p}::timestamptz`, filters.from);
	if (filters.to) add((p) => `ue.created_at <= ${p}::timestamptz`, filters.to);
	return { where: conditions.join(' AND '), params };
}

/** Input, output and total over every entry the filters match. */
export async function usageTotals(db: Db, filters: UsageFilters): Promise<UsageTotals> {
	const { where, params } = usageWhere(filters);
	const r = await db.query<UsageTotals>(
		`SELECT ${USAGE_TOKEN_SUMS_SQL} FROM usage_entries ue WHERE ${where}`,
		params,
	);
	return r.rows[0] ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
}

/** The columns naming an agent on a usage row, over `members m` and `member_agents ma`. */
const AGENT_COLUMNS_SQL = `ue.member_id AS agent_id,
       COALESCE(ma.title, m.display_name) AS agent_title,
       ${agentDisplayNameSql('ma', 'm')} AS agent_name`;
const AGENT_JOINS_SQL = `LEFT JOIN members m ON m.id = ue.member_id
       LEFT JOIN member_agents ma ON ma.id = ue.member_id`;
const AGENT_GROUP_SQL = 'ue.member_id, ma.title, ma.human_name, m.display_name';

/** One usage row per agent, bounded by the roster. */
export interface AgentUsageRow extends UsageTotals {
	agent_id: string;
	agent_title: string | null;
	/** The agent's own name, when it has one. Null means it goes by its role. */
	agent_name: string | null;
}

export async function usageByAgent(db: Db, filters: UsageFilters): Promise<AgentUsageRow[]> {
	const { where, params } = usageWhere(filters);
	const r = await db.query<AgentUsageRow>(
		`SELECT ${AGENT_COLUMNS_SQL}, ${USAGE_TOKEN_SUMS_SQL}
		   FROM usage_entries ue ${AGENT_JOINS_SQL}
		  WHERE ${where}
		  GROUP BY ${AGENT_GROUP_SQL}`,
		params,
	);
	return r.rows;
}

/** How a per-day series is split: one total a day, or one row per agent or credential a day. */
export type UsageDaySplit = 'none' | 'agent' | 'adapter';

const DAY_SPLITS: Record<UsageDaySplit, { columns: string; joins: string; group: string }> = {
	none: { columns: '', joins: '', group: '' },
	agent: {
		columns: `${AGENT_COLUMNS_SQL},`,
		joins: AGENT_JOINS_SQL,
		group: `, ${AGENT_GROUP_SQL}`,
	},
	adapter: {
		columns: 'ue.ai_provider_config_id, ue.provider, apc.label AS adapter_label,',
		joins: 'LEFT JOIN ai_provider_configs apc ON apc.id = ue.ai_provider_config_id',
		group: ', ue.ai_provider_config_id, ue.provider, apc.label',
	},
};

/** A UTC calendar day of a usage entry, as the date the budget windows also count in. */
const USAGE_DAY_SQL = `date_trunc('day', ue.created_at, 'UTC')::date`;

/**
 * A page of a per-day series: the newest `limit` days before `beforeDay` (all days
 * when null), whole - a split series has several rows a day, and a page never
 * ends partway through one. Days are "YYYY-MM-DD" text, never a bare `date`,
 * which a driver turns into a local-midnight Date.
 *
 * Returns the rows, oldest day first, and the day to pass back for the next page,
 * or null on the last one.
 */
export async function usageByDay<Row extends UsageTotals & { day: string }>(
	db: Db,
	filters: UsageFilters,
	split: UsageDaySplit,
	page: { limit: number; beforeDay: string | null },
): Promise<{ rows: Row[]; nextBeforeDay: string | null }> {
	const { where, params } = usageWhere(filters);
	const pageParams = [...params];
	let before = '';
	if (page.beforeDay) {
		pageParams.push(page.beforeDay);
		before = ` AND ${USAGE_DAY_SQL} < $${pageParams.length}::date`;
	}
	pageParams.push(page.limit + 1);
	const { columns, joins, group } = DAY_SPLITS[split];
	const r = await db.query<Row>(
		`WITH days AS (
		   SELECT ${USAGE_DAY_SQL} AS day FROM usage_entries ue
		    WHERE ${where}${before}
		    GROUP BY 1 ORDER BY 1 DESC LIMIT $${pageParams.length}
		 )
		 SELECT d.day::text AS day, ${columns} ${USAGE_TOKEN_SUMS_SQL}
		   FROM usage_entries ue
		   JOIN days d ON d.day = ${USAGE_DAY_SQL}
		   ${joins}
		  WHERE ${where}
		  GROUP BY d.day${group}
		  ORDER BY d.day`,
		pageParams,
	);
	const days = [...new Set(r.rows.map((row) => row.day))];
	if (days.length <= page.limit) return { rows: r.rows, nextBeforeDay: null };
	// One day past the page came back only to say there is more; it starts the next.
	const oldestDropped = days[0];
	const kept = r.rows.filter((row) => row.day !== oldestDropped);
	return { rows: kept, nextBeforeDay: kept[0]?.day ?? null };
}
