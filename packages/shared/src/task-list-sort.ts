/**
 * The orders the task list route accepts in its `sort` query (`<field>:<dir>`).
 * The web task list sends them and persists the last one picked per project.
 *
 * `work_order` is the default and ignores the direction. `priority` ascending is
 * urgent first and `status` ascending follows the lifecycle (backlog first) -
 * both are the database enum order.
 */
export const TASK_LIST_SORT_FIELDS = [
	'work_order',
	'created_at',
	'updated_at',
	'number',
	'title',
	'status',
	'priority',
	'assignee',
] as const;
export type TaskListSortField = (typeof TASK_LIST_SORT_FIELDS)[number];

export const TASK_LIST_SORT_DIRS = ['asc', 'desc'] as const;
export type TaskListSortDir = (typeof TASK_LIST_SORT_DIRS)[number];

export function isTaskListSortField(value: unknown): value is TaskListSortField {
	return (TASK_LIST_SORT_FIELDS as readonly unknown[]).includes(value);
}

export function isTaskListSortDir(value: unknown): value is TaskListSortDir {
	return (TASK_LIST_SORT_DIRS as readonly unknown[]).includes(value);
}
