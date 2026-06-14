export interface NestableTask {
	id: string;
	parent_task_id: string | null;
}

export type NestedTask<T extends NestableTask> = T & { depth: number };

/**
 * Reorders a flat task list so children appear directly beneath their parent
 * (when the parent is in the same list). Orphan children — parent not in the
 * batch — stay at the top level. Sibling order follows the input array order.
 */
export function nestTasksForDisplay<T extends NestableTask>(tasks: T[]): NestedTask<T>[] {
	if (tasks.length === 0) return [];

	const byId = new Map(tasks.map((t) => [t.id, t]));
	const rootIds = new Set(
		tasks.filter((t) => !t.parent_task_id || !byId.has(t.parent_task_id)).map((t) => t.id),
	);

	const result: NestedTask<T>[] = [];
	const emitted = new Set<string>();

	function walk(task: T, depth: number) {
		if (emitted.has(task.id)) return;
		emitted.add(task.id);
		result.push({ ...task, depth });
		for (const child of tasks) {
			if (child.parent_task_id === task.id) walk(child, depth + 1);
		}
	}

	for (const task of tasks) {
		if (rootIds.has(task.id)) walk(task, 0);
	}

	for (const task of tasks) {
		if (!emitted.has(task.id)) result.push({ ...task, depth: 0 });
	}

	return result;
}
