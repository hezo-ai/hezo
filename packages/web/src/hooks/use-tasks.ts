import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { useOptimisticMutation } from './use-optimistic-mutation';

export interface QueuedWakeup {
	reason: 'task_busy' | 'project_at_capacity' | 'agent_running';
	since: string;
	blocker_task_id: string | null;
	blocker_identifier: string | null;
	blocker_project_slug: string | null;
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
	assignee_type: 'agent' | 'user' | null;
	has_active_run: boolean;
	has_unread_admin_mention: boolean;
	queued_wakeup: QueuedWakeup | null;
	parent_task_id: string | null;
	labels: string[];
	progress_summary: string | null;
	rules: string | null;
	project_name: string | null;
	project_slug: string | null;
	comment_count: number;
	cost_cents: number;
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

interface TaskListResponse {
	data: Task[];
	meta: { page: number; per_page: number; total: number };
}

export function useTasks(
	projectId: string,
	filters?: TaskFilters,
	options?: { enabled?: boolean },
) {
	return useQuery({
		queryKey: ['projects', projectId, 'tasks', filters],
		queryFn: async () => {
			const params: Record<string, string | undefined> = { ...filters };
			const res = await api.get<TaskListResponse | Task[]>(
				`/api/projects/${projectId}/tasks`,
				params,
			);
			if (Array.isArray(res))
				return { data: res, meta: { page: 1, per_page: 50, total: res.length } };
			return res;
		},
		enabled: options?.enabled ?? true,
	});
}

export interface GlobalTask extends Task {
	team_slug: string;
	team_name: string;
}

/** Aggregates tasks across every visible project the user can see (the global "All Tasks"). */
export function useAllTasks(projects: { slug: string; teamSlug: string; teamName: string }[]) {
	const slugs = projects.map((p) => p.slug).sort();
	return useQuery({
		queryKey: ['tasks', 'all', slugs],
		queryFn: async (): Promise<GlobalTask[]> => {
			const perProject = await Promise.all(
				projects.map(async (p) => {
					const res = await api.get<TaskListResponse | Task[]>(`/api/projects/${p.slug}/tasks`, {
						per_page: '200',
					});
					const rows = Array.isArray(res) ? res : res.data;
					return rows.map((task) => ({ ...task, team_slug: p.teamSlug, team_name: p.teamName }));
				}),
			);
			return perProject.flat();
		},
		enabled: projects.length > 0,
	});
}

export function useTask(projectId: string, taskId: string) {
	return useQuery({
		queryKey: ['projects', projectId, 'tasks', taskId],
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
		queryKey: ['projects', projectId, 'tasks', 'resolve', key],
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
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'tasks'] }),
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
}

export function useUpdateTask(projectId: string, taskId: string) {
	return useOptimisticMutation<UpdateTaskVars, Task, Task>({
		mutationFn: (data) => api.patch<Task>(`/api/projects/${projectId}/tasks/${taskId}`, data),
		queryKey: ['projects', projectId, 'tasks', taskId],
		applyOptimistic: (current, vars) => {
			if (!current) return current;
			// Status flips only after the server confirms (children-closed and outstanding-activity
			// assertions run server-side, plus status changes trigger automations we can't predict).
			const { status: _status, ...optimistic } = vars;
			return { ...current, ...optimistic };
		},
		mergeResponse: (current, updated) => (current ? { ...current, ...updated } : current),
		invalidateOnSettled: [['projects', projectId, 'tasks']],
		errorMessage: 'Failed to update task',
	});
}

export interface TaskAncestor {
	id: string;
	identifier: string;
	title: string;
}

export function useTaskAncestors(projectId: string, taskId: string | undefined) {
	return useQuery({
		queryKey: ['projects', projectId, 'tasks', taskId, 'ancestors'],
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
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'tasks'] }),
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
}

export function useTaskDependencies(projectId: string, taskId: string) {
	return useQuery({
		queryKey: ['projects', projectId, 'tasks', taskId, 'dependencies'],
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
				queryKey: ['projects', projectId, 'tasks', taskId, 'dependencies'],
			}),
	});
}

export function useRemoveDependency(projectId: string, taskId: string) {
	return useMutation({
		mutationFn: (depId: string) =>
			api.delete(`/api/projects/${projectId}/tasks/${taskId}/dependencies/${depId}`),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: ['projects', projectId, 'tasks', taskId, 'dependencies'],
			}),
	});
}
