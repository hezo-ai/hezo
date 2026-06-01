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

export function useTasks(teamId: string, filters?: TaskFilters, options?: { enabled?: boolean }) {
	return useQuery({
		queryKey: ['teams', teamId, 'tasks', filters],
		queryFn: async () => {
			const params: Record<string, string | undefined> = { ...filters };
			const res = await api.get<TaskListResponse | Task[]>(`/api/teams/${teamId}/tasks`, params);
			if (Array.isArray(res))
				return { data: res, meta: { page: 1, per_page: 50, total: res.length } };
			return res;
		},
		enabled: options?.enabled ?? true,
	});
}

export function useTask(teamId: string, taskId: string) {
	return useQuery({
		queryKey: ['teams', teamId, 'tasks', taskId],
		queryFn: () => api.get<Task>(`/api/teams/${teamId}/tasks/${taskId}`),
	});
}

export interface TaskMentionData {
	identifier: string;
	title: string;
	project_slug: string;
	status: string;
}

export function useTaskMentions(teamId: string, candidates: string[]) {
	const key = useMemo(
		() => [...new Set(candidates.map((s) => s.toLowerCase()))].sort(),
		[candidates],
	);
	return useQuery({
		queryKey: ['teams', teamId, 'tasks', 'resolve', key],
		queryFn: () =>
			api.post<TaskMentionData[]>(`/api/teams/${teamId}/tasks/resolve`, {
				identifiers: key,
			}),
		enabled: !!teamId && key.length > 0,
		staleTime: 60_000,
	});
}

export function useCreateTask(teamId: string) {
	return useMutation({
		mutationFn: (data: {
			project_id: string;
			title: string;
			description?: string;
			assignee_id?: string;
			priority?: string;
			labels?: string[];
		}) => api.post<Task>(`/api/teams/${teamId}/tasks`, data),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'tasks'] }),
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

export function useUpdateTask(teamId: string, taskId: string) {
	return useOptimisticMutation<UpdateTaskVars, Task, Task>({
		mutationFn: (data) => api.patch<Task>(`/api/teams/${teamId}/tasks/${taskId}`, data),
		queryKey: ['teams', teamId, 'tasks', taskId],
		applyOptimistic: (current, vars) => {
			if (!current) return current;
			// Status flips only after the server confirms (children-closed and outstanding-activity
			// assertions run server-side, plus status changes trigger automations we can't predict).
			const { status: _status, ...optimistic } = vars;
			return { ...current, ...optimistic };
		},
		mergeResponse: (current, updated) => (current ? { ...current, ...updated } : current),
		invalidateOnSettled: [['teams', teamId, 'tasks']],
		errorMessage: 'Failed to update task',
	});
}

export interface TaskAncestor {
	id: string;
	identifier: string;
	title: string;
}

export function useTaskAncestors(teamId: string, taskId: string | undefined) {
	return useQuery({
		queryKey: ['teams', teamId, 'tasks', taskId, 'ancestors'],
		queryFn: () => api.get<TaskAncestor[]>(`/api/teams/${teamId}/tasks/${taskId}/ancestors`),
		enabled: !!teamId && !!taskId,
	});
}

export function useCreateSubTask(teamId: string, parentTaskId: string) {
	return useMutation({
		mutationFn: (data: {
			title: string;
			description?: string;
			assignee_id?: string;
			priority?: string;
		}) => api.post<Task>(`/api/teams/${teamId}/tasks/${parentTaskId}/sub-tasks`, data),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'tasks'] }),
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

export function useTaskDependencies(teamId: string, taskId: string) {
	return useQuery({
		queryKey: ['teams', teamId, 'tasks', taskId, 'dependencies'],
		queryFn: () => api.get<TaskDependency[]>(`/api/teams/${teamId}/tasks/${taskId}/dependencies`),
	});
}

export function useAddDependency(teamId: string, taskId: string) {
	return useMutation({
		mutationFn: (blockedByTaskId: string) =>
			api.post(`/api/teams/${teamId}/tasks/${taskId}/dependencies`, {
				blocked_by_task_id: blockedByTaskId,
			}),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: ['teams', teamId, 'tasks', taskId, 'dependencies'],
			}),
	});
}

export function useRemoveDependency(teamId: string, taskId: string) {
	return useMutation({
		mutationFn: (depId: string) =>
			api.delete(`/api/teams/${teamId}/tasks/${taskId}/dependencies/${depId}`),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: ['teams', teamId, 'tasks', taskId, 'dependencies'],
			}),
	});
}
