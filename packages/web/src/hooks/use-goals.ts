import type { Goal, GoalStatus } from '@hezo/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

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
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'goals'] }),
	});
}

export function useUpdateGoal(teamId: string, goalId: string) {
	return useMutation({
		mutationFn: (data: {
			title?: string;
			description?: string;
			project_id?: string | null;
			status?: GoalStatus;
		}) => api.patch<Goal>(`/api/teams/${teamId}/goals/${goalId}`, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'goals'] });
		},
	});
}

export function useArchiveGoal(teamId: string) {
	return useMutation({
		mutationFn: (goalId: string) => api.delete<Goal>(`/api/teams/${teamId}/goals/${goalId}`),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'goals'] }),
	});
}
