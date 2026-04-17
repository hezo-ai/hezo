import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export interface Project {
	id: string;
	company_id: string;
	name: string;
	slug: string;
	description: string;
	docker_base_image: string | null;
	container_id: string | null;
	container_status: 'creating' | 'running' | 'stopping' | 'stopped' | 'error' | null;
	dev_ports: Array<{ container: number; host: number }>;
	repo_count: number;
	open_issue_count: number;
	created_at: string;
	repos?: Repo[];
	planning_issue_id?: string;
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

export function useProject(companyId: string, projectId: string, options?: { enabled?: boolean }) {
	return useQuery({
		queryKey: ['companies', companyId, 'projects', projectId],
		queryFn: () => api.get<Project>(`/api/companies/${companyId}/projects/${projectId}`),
		enabled: options?.enabled,
	});
}

export function useCreateProject(companyId: string) {
	return useMutation({
		mutationFn: (data: { name: string; description: string }) =>
			api.post<Project>(`/api/companies/${companyId}/projects`, data),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'projects'] }),
	});
}

export function useUpdateProject(companyId: string, projectId: string) {
	return useMutation({
		mutationFn: (data: { name?: string; description?: string }) =>
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
