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
