// Per-project persistence for the task list's filter bar. The user's last-set
// search / status / owner / sort selections are written to localStorage keyed by
// project slug, so returning to the same project's task page restores them.
// Keyed by the route-param project slug (the same handle the component already
// holds), never a resolved UUID.

import { TaskStatus } from '@hezo/shared';

export type TaskSortField = 'work_order' | 'created_at' | 'updated_at';
export type TaskSortDir = 'asc' | 'desc';

const KNOWN_STATUSES = new Set<string>(Object.values(TaskStatus));

export interface StoredTaskFilters {
	search: string;
	statusValues: string[];
	ownerValues: string[];
	sortField: TaskSortField;
	sortDir: TaskSortDir;
}

const STORAGE_PREFIX = 'hezo:task-filters:';
const SORT_FIELDS: readonly TaskSortField[] = ['work_order', 'created_at', 'updated_at'];
const SORT_DIRS: readonly TaskSortDir[] = ['asc', 'desc'];

function keyFor(projectId: string): string {
	return `${STORAGE_PREFIX}${projectId}`;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Read the persisted filters for a project, or `null` when nothing is stored (so
 * the caller can fall back to its own defaults). Tolerates malformed / stale JSON
 * by returning `null`, and coerces each field to a safe shape so a tampered or
 * out-of-date entry can never feed garbage into the API query.
 */
export function readStoredTaskFilters(projectId: string): StoredTaskFilters | null {
	if (typeof window === 'undefined' || !projectId) return null;
	try {
		const raw = localStorage.getItem(keyFor(projectId));
		if (!raw) return null;
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== 'object' || parsed === null) return null;
		const obj = parsed as Record<string, unknown>;
		return {
			search: typeof obj.search === 'string' ? obj.search : '',
			// Drop any stale/unknown status (e.g. a persisted `closed` from before
			// that status was removed) — the server casts each value `::task_status`
			// and would 500 on an unknown one.
			statusValues: stringArray(obj.statusValues).filter((s) => KNOWN_STATUSES.has(s)),
			ownerValues: stringArray(obj.ownerValues),
			sortField: SORT_FIELDS.includes(obj.sortField as TaskSortField)
				? (obj.sortField as TaskSortField)
				: 'work_order',
			sortDir: SORT_DIRS.includes(obj.sortDir as TaskSortDir)
				? (obj.sortDir as TaskSortDir)
				: 'asc',
		};
	} catch {
		return null;
	}
}

export function writeStoredTaskFilters(projectId: string, filters: StoredTaskFilters): void {
	if (typeof window === 'undefined' || !projectId) return;
	try {
		localStorage.setItem(keyFor(projectId), JSON.stringify(filters));
	} catch {
		// ignore storage failures (private mode, quota, etc.)
	}
}

export function clearStoredTaskFilters(projectId: string): void {
	if (typeof window === 'undefined' || !projectId) return;
	try {
		localStorage.removeItem(keyFor(projectId));
	} catch {
		// ignore storage failures (private mode, quota, etc.)
	}
}
