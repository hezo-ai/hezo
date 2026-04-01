import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import type { Repo } from './use-projects';

export function useRepos(companyId: string, projectId: string) {
	return useQuery({
		queryKey: ['companies', companyId, 'projects', projectId, 'repos'],
		queryFn: () => api.get<Repo[]>(`/api/companies/${companyId}/projects/${projectId}/repos`),
	});
}

export function useCreateRepo(companyId: string, projectId: string) {
	return useMutation({
		mutationFn: (data: { short_name: string; url: string }) =>
			api.post<Repo>(`/api/companies/${companyId}/projects/${projectId}/repos`, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'projects', projectId] });
			queryClient.invalidateQueries({
				queryKey: ['companies', companyId, 'projects', projectId, 'repos'],
			});
		},
	});
}

export function useDeleteRepo(companyId: string, projectId: string) {
	return useMutation({
		mutationFn: (repoId: string) =>
			api.delete(`/api/companies/${companyId}/projects/${projectId}/repos/${repoId}`),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'projects', projectId] });
			queryClient.invalidateQueries({
				queryKey: ['companies', companyId, 'projects', projectId, 'repos'],
			});
		},
	});
}
