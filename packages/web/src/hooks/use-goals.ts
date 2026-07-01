import type {
	GoalCheckFrequency,
	GoalHistoryPoint,
	GoalRunActivity,
	GoalWithProject,
	ProgressUpdateRunSummary,
} from '@hezo/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';
import { useOptimisticMutation } from './use-optimistic-mutation';
import { toast } from './use-toast';

export type { GoalRunActivity, GoalWithProject, ProgressUpdateRunSummary };

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

/** A single goal with embedded history, for the goal detail page. */
export function useGoal(projectId: string, goalId: string) {
	return useQuery({
		queryKey: queryKeys.projects.goal(projectId, goalId),
		queryFn: () => api.get<GoalWithProject>(`/api/projects/${projectId}/goals/${goalId}`),
	});
}

/** A goal's full (uncapped) progress history, for the detail page chart. */
export function useGoalHistory(projectId: string, goalId: string) {
	return useQuery({
		queryKey: queryKeys.projects.goalHistory(projectId, goalId),
		queryFn: () =>
			api.get<GoalHistoryPoint[]>(`/api/projects/${projectId}/goals/${goalId}/history`),
	});
}

/** The progress-update runs for this project (newest-first as returned by the server). */
export function useGoalRuns(projectId: string) {
	return useQuery({
		queryKey: queryKeys.projects.goalRuns(projectId),
		queryFn: () => api.get<ProgressUpdateRunSummary[]>(`/api/projects/${projectId}/goals/runs`),
	});
}

/** The progress-update runs that did something for one goal — shown at the bottom of its detail page. */
export function useGoalRunActivity(projectId: string, goalId: string) {
	return useQuery({
		queryKey: queryKeys.projects.goalRunsForGoal(projectId, goalId),
		queryFn: () => api.get<GoalRunActivity[]>(`/api/projects/${projectId}/goals/${goalId}/runs`),
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
			// open_goal_count (which drives the sidebar "no goals yet" dot) is carried on both the
			// project index and the detail payload — refresh both so the dot clears at once.
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) });
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.all() });
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
			// Archiving the last goal must bring the sidebar "no goals yet" dot back — refresh the
			// project index and detail, which both carry open_goal_count.
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) });
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.all() });
		},
	});
}

/**
 * Manually run the Captain's progress-update on demand ("Run now" on the Goals page). The run is
 * long-running/async, so this is invalidate + refetch — the new run surfaces via the runs query and
 * the WebSocket. A 200 with `dispatched:false` (e.g. nothing due) is a neutral notice, not an error.
 */
export function useRunProgressUpdateNow(projectId: string) {
	return useMutation({
		mutationFn: () =>
			api.post<{ dispatched: boolean; reason?: string }>(
				`/api/projects/${projectId}/goals/run-now`,
				{},
			),
		onSuccess: (data) => {
			if (!data.dispatched) {
				toast.info(
					data.reason === 'no_due_goals'
						? 'No goals are due for a progress update right now.'
						: 'No progress update was started.',
				);
				return;
			}
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.goalRuns(projectId) });
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.goals(projectId) });
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.progress(projectId) });
		},
		onError: (error: { message?: string }) => {
			toast.error(error?.message ?? 'Failed to start progress update');
		},
	});
}
