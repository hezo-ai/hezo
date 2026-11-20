import type { ParseResult } from './i18n/format.js';

/**
 * The folding cards on the task page whose open/folded state is saved on the
 * task. One state per task, shared by everyone who opens it.
 */
export const TaskSection = {
	SubTasks: 'sub_tasks',
	Rules: 'rules',
	ProgressSummary: 'progress_summary',
} as const;
export type TaskSection = (typeof TaskSection)[keyof typeof TaskSection];

export const TASK_SECTIONS = [
	TaskSection.ProgressSummary,
	TaskSection.Rules,
	TaskSection.SubTasks,
] as const;

/** How each card starts on a task that has no saved state for it. */
export const TASK_SECTION_DEFAULT_OPEN: Record<TaskSection, boolean> = {
	[TaskSection.SubTasks]: true,
	[TaskSection.Rules]: false,
	[TaskSection.ProgressSummary]: false,
};

/** The saved state: only the cards someone has toggled on this task. */
export type TaskSectionsOpen = Partial<Record<TaskSection, boolean>>;

export function isTaskSection(value: unknown): value is TaskSection {
	return typeof value === 'string' && (TASK_SECTIONS as readonly string[]).includes(value);
}

/** Validate a partial update to a task's saved section state. */
export function parseTaskSectionsOpenPatch(input: unknown): ParseResult<TaskSectionsOpen> {
	if (typeof input !== 'object' || input === null || Array.isArray(input)) {
		return { ok: false, error: 'sections_open must be an object' };
	}
	const patch: TaskSectionsOpen = {};
	for (const [key, value] of Object.entries(input)) {
		if (!isTaskSection(key)) {
			return {
				ok: false,
				error: `unknown section "${key}"; expected one of: ${TASK_SECTIONS.join(', ')}`,
			};
		}
		if (typeof value !== 'boolean') {
			return { ok: false, error: `sections_open.${key} must be a boolean` };
		}
		patch[key] = value;
	}
	if (Object.keys(patch).length === 0) {
		return {
			ok: false,
			error: `sections_open needs at least one of: ${TASK_SECTIONS.join(', ')}`,
		};
	}
	return { ok: true, value: patch };
}

/**
 * The state each card renders with: the defaults, overlaid with whatever the
 * task has saved. A malformed saved value falls back to that card's default.
 */
export function resolveTaskSectionsOpen(stored: unknown): Record<TaskSection, boolean> {
	const resolved = { ...TASK_SECTION_DEFAULT_OPEN };
	if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return resolved;
	for (const [key, value] of Object.entries(stored)) {
		if (isTaskSection(key) && typeof value === 'boolean') resolved[key] = value;
	}
	return resolved;
}
