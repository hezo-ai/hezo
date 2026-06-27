import type { GoalCheckFrequency, GoalCheckRunSummary, GoalWithProject } from '@hezo/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';
import { useOptimisticMutation } from './use-optimistic-mutation';

export type { GoalCheckRunSummary, GoalWithProject };

interface UseGoalsOptions {
	includeArchived?: boolean;
	enabled?: boolean;
}

/** The active project's goals (optionally including archived ones), with embedded history. */
export function useGoals(projectId: string, options?: UseGoalsOptions) {
	const includeArchived = options?.includeArchived ?? false;
	const filters = { include_archived: includeArchived };
	return useQuery({
		queryKey: queryKeys.projects.goalsFiltered(projectId, filters),
		queryFn: () =>
			api.get<GoalWithProject[]>(
				`/api/projects/${projectId}/goals`,
				includeArchived ? { include_archived: 'true' } : undefined,
			),
		enabled: options?.enabled ?? true,
	});
}

/** The goal-check runs for this project (newest-first as returned by the server). */
export function useGoalRuns(projectId: string) {
	return useQuery({
		queryKey: queryKeys.projects.goalRuns(projectId),
		queryFn: () => api.get<GoalCheckRunSummary[]>(`/api/projects/${projectId}/goals/runs`),
	});
}

interface CreateGoalVars {
	title: string;
	measurement?: string;
	actions?: string;
	check_frequency?: GoalCheckFrequency;
	target_date?: string;
}

/** Response-driven create: the server assigns id/health/etc, so seed from the response. */
export function useCreateGoal(projectId: string) {
	return useMutation({
		mutationFn: (data: CreateGoalVars) =>
			api.post<GoalWithProject>(`/api/projects/${projectId}/goals`, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.goals(projectId) });
		},
	});
}

interface UpdateGoalVars {
	title?: string;
	measurement?: string;
	actions?: string;
	check_frequency?: GoalCheckFrequency;
	target_date?: string | null;
	archived?: boolean;
}

/** Optimistic field edits against a goal's detail cache, re-flowing the list on settle. */
export function useUpdateGoal(projectId: string, goalId: string) {
	return useOptimisticMutation<UpdateGoalVars, GoalWithProject, GoalWithProject>({
		mutationFn: (vars) =>
			api.patch<GoalWithProject>(`/api/projects/${projectId}/goals/${goalId}`, vars),
		queryKey: queryKeys.projects.goal(projectId, goalId),
		applyOptimistic: (current, vars) => {
			if (!current) return current;
			const { archived: _archived, ...rest } = vars;
			return { ...current, ...rest };
		},
		mergeResponse: (current, updated) => (current ? { ...current, ...updated } : current),
		invalidateOnSettled: [queryKeys.projects.goalsFiltered(projectId, undefined)],
		errorMessage: 'Failed to update goal',
	});
}

/** Archive a goal (DELETE), then re-flow the goal lists. */
export function useArchiveGoal(projectId: string) {
	return useMutation({
		mutationFn: (goalId: string) =>
			api.delete<GoalWithProject>(`/api/projects/${projectId}/goals/${goalId}`),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.goals(projectId) });
		},
	});
}
