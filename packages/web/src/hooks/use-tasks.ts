import type { HeartbeatRunStatus } from '@hezo/shared';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';
import { useSimpleOptimisticUpdate } from './use-optimistic-mutation';
import { toast } from './use-toast';

export interface QueuedWakeup {
	/** `project_at_capacity` is the pre-rename legacy value, kept for the upgrade window. */
	reason: 'task_busy' | 'instance_at_capacity' | 'project_at_capacity' | 'agent_running';
	since: string;
	blocker_task_id: string | null;
	blocker_identifier: string | null;
	blocker_project_slug: string | null;
}

export interface ActiveRun {
	status: typeof HeartbeatRunStatus.Running | typeof HeartbeatRunStatus.Queued;
	/** The agent the run belongs to — not necessarily the task's assignee. */
	member_id: string;
	/** Why the run is still waiting, when the server recorded a reason. */
	queued_reason: string | null;
}

export interface Task {
	id: string;
	team_id: string;
	project_id: string | null;
	identifier: string;
	number: number;
	title: string;
	description: string | null;
	status: string;
	priority: string;
	assignee_id: string | null;
	assignee_name: string | null;
	/** Agent slug for an agent assignee (null for human assignees / unassigned). */
	assignee_slug: string | null;
	assignee_type: 'agent' | 'user' | null;
	has_active_run: boolean;
	/**
	 * The task's current non-terminal run, when there is one. `has_active_run` is
	 * the same fact as a boolean; this carries the detail needed to tell an
	 * executing run apart from one still waiting to start, and to know whose run
	 * it is (any agent's run on the task blocks reassignment, not just the
	 * assignee's). Only the single-task endpoint returns it — list rows get the
	 * boolean alone, hence optional rather than nullable.
	 */
	active_run?: ActiveRun | null;
	/** Number of agent runs that have started on this task (excludes queued). */
	run_count: number;
	/** Summed wall-clock duration of finished runs, in seconds. */
	total_duration_seconds: number;
	/** Summed cost across the task's runs, in cents. */
	total_cost_cents: number;
	has_unread_admin_mention: boolean;
	last_run_status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | null;
	/** Id of the last completed run — the target of a manual retry. */
	last_run_id: string | null;
	last_run_comment_id: string | null;
	/** Deep-link slug for the last run's comment (`#comment-<public_id>`). */
	last_run_comment_public_id: string | null;
	queued_wakeup: QueuedWakeup | null;
	parent_task_id: string | null;
	labels: string[];
	progress_summary: string | null;
	rules: string | null;
	project_name: string | null;
	project_slug: string | null;
	comment_count: number;
	created_at: string;
	updated_at: string;
}

export interface TaskFilters {
	status?: string;
	priority?: string;
	project_id?: string;
	assignee_id?: string;
	parent_task_id?: string;
	search?: string;
	sort?: string;
	page?: string;
	per_page?: string;
}

export function useTasks(
	projectId: string,
	filters?: TaskFilters,
	options?: { enabled?: boolean },
) {
	return useQuery({
		queryKey: queryKeys.projects.tasksFiltered(projectId, filters),
		queryFn: async () => {
			const params: Record<string, string | undefined> = { ...filters };
			return api.getPaginated<Task>(`/api/projects/${projectId}/tasks`, params);
		},
		enabled: options?.enabled ?? true,
	});
}

/**
 * Infinite (page-accumulating) variant of {@link useTasks} for the main task
 * list. Pages are fetched via offset pagination and concatenated client-side as
 * the user scrolls. Keyed separately from `tasksFiltered` so the pinned
 * in-progress query (which uses `useTasks`) stays independent; both share the
 * `projects.tasks(slug)` prefix, so mutation/WebSocket invalidation still reaches
 * this query.
 */
export function useInfiniteTasks(
	projectId: string,
	filters?: Omit<TaskFilters, 'page' | 'per_page'>,
	options?: { enabled?: boolean; perPage?: number },
) {
	const perPage = options?.perPage ?? 50;
	return useInfiniteQuery({
		queryKey: queryKeys.projects.tasksInfinite(projectId, {
			...filters,
			per_page: String(perPage),
		}),
		initialPageParam: 1,
		queryFn: ({ pageParam }) => {
			const params: Record<string, string | undefined> = {
				...filters,
				page: String(pageParam),
				per_page: String(perPage),
			};
			return api.getPaginated<Task>(`/api/projects/${projectId}/tasks`, params);
		},
		getNextPageParam: (lastPage) => {
			const { page, per_page, total } = lastPage.meta;
			return page * per_page < total ? page + 1 : undefined;
		},
		enabled: options?.enabled ?? true,
	});
}

export function useTask(projectId: string, taskId: string) {
	return useQuery({
		queryKey: queryKeys.projects.task(projectId, taskId),
		queryFn: () => api.get<Task>(`/api/projects/${projectId}/tasks/${taskId}`),
	});
}

export interface TaskMentionData {
	identifier: string;
	title: string;
	project_slug: string;
	status: string;
}

export function useTaskMentions(projectId: string, candidates: string[]) {
	const key = useMemo(
		() => [...new Set(candidates.map((s) => s.toLowerCase()))].sort(),
		[candidates],
	);
	return useQuery({
		queryKey: queryKeys.projects.tasksResolve(projectId, key),
		queryFn: () =>
			api.post<TaskMentionData[]>(`/api/projects/${projectId}/tasks/resolve`, {
				identifiers: key,
			}),
		enabled: !!projectId && key.length > 0,
		staleTime: 60_000,
	});
}

export function useCreateTask(projectId: string) {
	return useMutation({
		mutationFn: (data: {
			project_id?: string;
			title: string;
			description?: string;
			assignee_id?: string;
			priority?: string;
			labels?: string[];
		}) => api.post<Task>(`/api/projects/${projectId}/tasks`, data),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.tasks(projectId) }),
	});
}

interface UpdateTaskVars {
	title?: string;
	description?: string;
	status?: string;
	priority?: string;
	assignee_id?: string | null;
	labels?: string[];
	progress_summary?: string | null;
	rules?: string | null;
	/** A task identifier or UUID to nest under; null promotes to top level. */
	parent_task_id?: string | null;
}

export function useUpdateTask(projectId: string, taskId: string) {
	// Status flips only after the server confirms (children-closed and outstanding-activity
	// assertions run server-side, plus status changes trigger automations we can't predict),
	// so it's omitted from the optimistic apply and picked up by the response merge.
	//
	// parent_task_id gets the same treatment, and needs it more: we send an
	// identifier but the column holds a UUID, so an optimistic apply would put
	// "BE-2" where every reader expects a UUID until the response landed. The
	// server also rejects moves we cannot fully predict here (cycle, sub-tree
	// depth, a closed destination).
	return useSimpleOptimisticUpdate<Task, UpdateTaskVars>(
		`/api/projects/${projectId}/tasks/${taskId}`,
		queryKeys.projects.task(projectId, taskId),
		{
			omitOptimistic: ['status', 'parent_task_id'],
			invalidateOnSettled: [queryKeys.projects.tasks(projectId)],
			errorMessage: 'Failed to update task',
		},
	);
}

export interface TaskAncestor {
	id: string;
	identifier: string;
	title: string;
}

export function useTaskAncestors(projectId: string, taskId: string | undefined) {
	return useQuery({
		queryKey: queryKeys.projects.taskAncestors(projectId, taskId),
		queryFn: () => api.get<TaskAncestor[]>(`/api/projects/${projectId}/tasks/${taskId}/ancestors`),
		enabled: !!projectId && !!taskId,
	});
}

export function useCreateSubTask(projectId: string, parentTaskId: string) {
	return useMutation({
		mutationFn: (data: {
			title: string;
			description?: string;
			assignee_id?: string;
			priority?: string;
		}) => api.post<Task>(`/api/projects/${projectId}/tasks/${parentTaskId}/sub-tasks`, data),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.tasks(projectId) }),
	});
}

export interface TaskDependency {
	id: string;
	task_id: string;
	blocked_by_task_id: string;
	blocked_by_identifier: string;
	blocked_by_title: string;
	blocked_by_status: string;
	blocked_by_project_slug: string;
	blocked_by_has_active_run: boolean;
	blocked_by_queued_wakeup: QueuedWakeup | null;
}

export function useTaskDependencies(projectId: string, taskId: string) {
	return useQuery({
		queryKey: queryKeys.projects.taskDependencies(projectId, taskId),
		queryFn: () =>
			api.get<TaskDependency[]>(`/api/projects/${projectId}/tasks/${taskId}/dependencies`),
	});
}

export function useAddDependency(projectId: string, taskId: string) {
	return useMutation({
		mutationFn: (blockedByTaskId: string) =>
			api.post(`/api/projects/${projectId}/tasks/${taskId}/dependencies`, {
				blocked_by_task_id: blockedByTaskId,
			}),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: queryKeys.projects.taskDependencies(projectId, taskId),
			}),
		onError: () => toast.error('Failed to add dependency'),
	});
}

export function useRemoveDependency(projectId: string, taskId: string) {
	return useMutation({
		mutationFn: (depId: string) =>
			api.delete(`/api/projects/${projectId}/tasks/${taskId}/dependencies/${depId}`),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: queryKeys.projects.taskDependencies(projectId, taskId),
			}),
		onError: () => toast.error('Failed to remove dependency'),
	});
}
