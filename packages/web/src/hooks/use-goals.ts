import type { Goal, GoalStatus } from '@hezo/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export interface GoalWithProject extends Goal {
	project_name: string | null;
	project_slug: string | null;
}

export function useGoals(companyId: string) {
	return useQuery({
		queryKey: ['companies', companyId, 'goals'],
		queryFn: () => api.get<GoalWithProject[]>(`/api/companies/${companyId}/goals`),
	});
}

export function useCreateGoal(companyId: string) {
	return useMutation({
		mutationFn: (data: { title: string; description?: string; project_id?: string | null }) =>
			api.post<Goal>(`/api/companies/${companyId}/goals`, data),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'goals'] }),
	});
}

export function useUpdateGoal(companyId: string, goalId: string) {
	return useMutation({
		mutationFn: (data: {
			title?: string;
			description?: string;
			project_id?: string | null;
			status?: GoalStatus;
		}) => api.patch<Goal>(`/api/companies/${companyId}/goals/${goalId}`, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'goals'] });
		},
	});
}

export function useArchiveGoal(companyId: string) {
	return useMutation({
		mutationFn: (goalId: string) => api.delete<Goal>(`/api/companies/${companyId}/goals/${goalId}`),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'goals'] }),
	});
}
