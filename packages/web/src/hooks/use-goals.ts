import { type Goal, GoalStatus } from '@hezo/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { useOptimisticMutation } from './use-optimistic-mutation';

export interface GoalWithProject extends Goal {
	project_name: string | null;
	project_slug: string | null;
}

export function useGoals(teamId: string) {
	return useQuery({
		queryKey: ['teams', teamId, 'goals'],
		queryFn: () => api.get<GoalWithProject[]>(`/api/teams/${teamId}/goals`),
	});
}

export function useCreateGoal(teamId: string) {
	return useMutation({
		mutationFn: (data: { title: string; description?: string; project_id?: string | null }) =>
			api.post<Goal>(`/api/teams/${teamId}/goals`, data),
		onSuccess: (created) => {
			queryClient.setQueryData<GoalWithProject[]>(['teams', teamId, 'goals'], (prev) => {
				const row = created as GoalWithProject;
				return prev ? [row, ...prev.filter((g) => g.id !== row.id)] : [row];
			});
			queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'goals'] });
		},
	});
}

interface UpdateGoalVars {
	title?: string;
	description?: string;
	project_id?: string | null;
	status?: GoalStatus;
}

export function useUpdateGoal(teamId: string, goalId: string) {
	return useOptimisticMutation<UpdateGoalVars, Goal, GoalWithProject[]>({
		mutationFn: (data) => api.patch<Goal>(`/api/teams/${teamId}/goals/${goalId}`, data),
		queryKey: ['teams', teamId, 'goals'],
		applyOptimistic: (current, vars) =>
			current?.map((g) => (g.id === goalId ? { ...g, ...vars } : g)),
		mergeResponse: (current, updated) =>
			current?.map((g) => (g.id === goalId ? { ...g, ...updated } : g)),
		errorMessage: 'Failed to update goal',
	});
}

export function useArchiveGoal(teamId: string) {
	return useOptimisticMutation<string, Goal, GoalWithProject[]>({
		mutationFn: (goalId) => api.delete<Goal>(`/api/teams/${teamId}/goals/${goalId}`),
		queryKey: ['teams', teamId, 'goals'],
		applyOptimistic: (current, goalId) =>
			current?.map((g) => (g.id === goalId ? { ...g, status: GoalStatus.Archived } : g)),
		mergeResponse: (current, updated) =>
			current?.map((g) => (g.id === updated.id ? { ...g, ...updated } : g)),
		errorMessage: 'Failed to archive goal',
	});
}
