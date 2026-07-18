import { TaskPriority, TERMINAL_TASK_STATUSES } from '@hezo/shared';

const TASK_ALIAS = 'i';

export const TASK_LIST_SORT_FIELDS = [
	'work_order',
	'created_at',
	'updated_at',
	'priority',
	'number',
] as const;
export type TaskListSortField = (typeof TASK_LIST_SORT_FIELDS)[number];

export function taskActiveRunExistsSql(alias = TASK_ALIAS): string {
	return `EXISTS (
    SELECT 1 FROM heartbeat_runs hr
    WHERE hr.task_id = ${alias}.id AND hr.status IN ('running', 'queued')
  )`;
}

/** Parameterized EXISTS for open dependency blockers (non-terminal upstream tasks). */
export function appendOpenBlockerExistsSql(
	alias: string,
	paramStart: number,
	params: unknown[],
): string {
	const termList = TERMINAL_TASK_STATUSES.map((_, i) => `$${paramStart + i}::task_status`).join(
		', ',
	);
	params.push(...TERMINAL_TASK_STATUSES);
	return `EXISTS (
    SELECT 1 FROM task_dependencies d
    JOIN tasks b ON b.id = d.blocked_by_task_id
    WHERE d.task_id = ${alias}.id
      AND b.status NOT IN (${termList})
  )`;
}

/** Priority rank matching JobManager task selection (urgent first). */
export function appendPriorityOrderSql(
	alias: string,
	paramStart: number,
	params: unknown[],
): string {
	const priorities = [
		TaskPriority.Urgent,
		TaskPriority.High,
		TaskPriority.Medium,
		TaskPriority.Low,
	];
	const cases = priorities
		.map((_, i) => `WHEN $${paramStart + i}::task_priority THEN ${i}`)
		.join(' ');
	params.push(...priorities);
	return `CASE ${alias}.priority ${cases} END`;
}

export function parseTaskListSort(sortParam: string | undefined): {
	field: TaskListSortField;
	direction: 'ASC' | 'DESC';
} {
	const raw = sortParam ?? 'work_order:asc';
	const [field, dir] = raw.split(':');
	const direction = dir === 'asc' ? 'ASC' : 'DESC';
	if ((TASK_LIST_SORT_FIELDS as readonly string[]).includes(field)) {
		return { field: field as TaskListSortField, direction };
	}
	return { field: 'work_order', direction: 'ASC' };
}

/**
 * Build ORDER BY for the task list. Always pins active runs first.
 * `work_order`: ready → priority → ticket number (matches agent dispatch).
 */
export function buildTaskListOrderBy(
	field: TaskListSortField,
	direction: 'ASC' | 'DESC',
	params: unknown[],
	idx: number,
): { sql: string; nextIdx: number } {
	const activeRun = taskActiveRunExistsSql();
	if (field === 'work_order') {
		const blockerStart = idx;
		const blockerSql = appendOpenBlockerExistsSql(TASK_ALIAS, blockerStart, params);
		idx += TERMINAL_TASK_STATUSES.length;
		const priorityStart = idx;
		const prioritySql = appendPriorityOrderSql(TASK_ALIAS, priorityStart, params);
		idx += 4;
		return {
			sql: `${activeRun} DESC, ${blockerSql} ASC, ${prioritySql} ASC, ${TASK_ALIAS}.number ASC`,
			nextIdx: idx,
		};
	}
	return {
		sql: `${activeRun} DESC, ${TASK_ALIAS}.${field} ${direction}`,
		nextIdx: idx,
	};
}

/**
 * Build a relevance-rank expression for a task search term, meant to be prepended
 * to the task-list ORDER BY so the best identifier match floats to the top.
 *
 * The `search` filter matches the term as a substring of title, description OR
 * identifier, but the sort field (recency / work order) is otherwise blind to
 * *which* column matched — so a task that merely mentions the term in its body can
 * outrank the task whose identifier/number *is* the term (searching "169" leaving
 * HM-169 buried under HM-167). This tier makes the identifier win.
 *
 * Lower rank sorts first (ASC):
 *   0 — the term is the whole identifier (`HM-169` / `hm-169`)
 *   1 — the term is the task number (`169` → HM-169)
 *   2 — the identifier contains the term (`16` → HM-169)
 *   3 — the title contains the term
 *   4 — matched on description only
 *
 * Pushes two params (the raw term, then its `%term%` ILIKE pattern) and returns
 * the CASE expression plus the next free placeholder index.
 */
export function buildSearchRelevanceOrderSql(
	search: string,
	params: unknown[],
	idx: number,
): { sql: string; nextIdx: number } {
	const exactIdx = idx;
	params.push(search);
	const likeIdx = idx + 1;
	params.push(`%${search}%`);
	const sql = `CASE
      WHEN LOWER(${TASK_ALIAS}.identifier) = LOWER($${exactIdx}) THEN 0
      WHEN ${TASK_ALIAS}.number::text = $${exactIdx} THEN 1
      WHEN ${TASK_ALIAS}.identifier ILIKE $${likeIdx} THEN 2
      WHEN ${TASK_ALIAS}.title ILIKE $${likeIdx} THEN 3
      ELSE 4 END`;
	return { sql, nextIdx: idx + 2 };
}
