import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export interface Project {
	id: string;
	company_id: string;
	name: string;
	slug: string;
	goal: string | null;
	docker_base_image: string | null;
	repo_count: number;
	open_issue_count: number;
	created_at: string;
	repos?: Repo[];
}

export interface Repo {
	id: string;
	project_id: string;
	short_name: string;
	repo_identifier: string;
	host_type: string;
	created_at: string;
}

export function useProjects(companyId: string) {
	return useQuery({
		queryKey: ['companies', companyId, 'projects'],
		queryFn: () => api.get<Project[]>(`/api/companies/${companyId}/projects`),
	});
}

export function useProject(companyId: string, projectId: string) {
	return useQuery({
		queryKey: ['companies', companyId, 'projects', projectId],
		queryFn: () => api.get<Project>(`/api/companies/${companyId}/projects/${projectId}`),
	});
}

export function useCreateProject(companyId: string) {
	return useMutation({
		mutationFn: (data: { name: string; goal?: string }) =>
			api.post<Project>(`/api/companies/${companyId}/projects`, data),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'projects'] }),
	});
}

export function useUpdateProject(companyId: string, projectId: string) {
	return useMutation({
		mutationFn: (data: { name?: string; goal?: string }) =>
			api.patch<Project>(`/api/companies/${companyId}/projects/${projectId}`, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'projects'] });
			queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'projects', projectId] });
		},
	});
}

export function useDeleteProject(companyId: string) {
	return useMutation({
		mutationFn: (projectId: string) =>
			api.delete(`/api/companies/${companyId}/projects/${projectId}`),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'projects'] }),
	});
}
