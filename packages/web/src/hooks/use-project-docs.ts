import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export interface ProjectDoc {
	filename: string;
	path: string;
	content?: string;
}

export function useProjectDocs(companyId: string, projectId: string) {
	return useQuery({
		queryKey: ['companies', companyId, 'projects', projectId, 'docs'],
		queryFn: () => api.get<ProjectDoc[]>(`/api/companies/${companyId}/projects/${projectId}/docs`),
		enabled: !!projectId,
	});
}

export function useProjectDoc(companyId: string, projectId: string, filename: string) {
	return useQuery({
		queryKey: ['companies', companyId, 'projects', projectId, 'docs', filename],
		queryFn: () =>
			api.get<ProjectDoc>(`/api/companies/${companyId}/projects/${projectId}/docs/${filename}`),
		enabled: !!filename,
	});
}

export function useUpdateProjectDoc(companyId: string, projectId: string) {
	return useMutation({
		mutationFn: ({ filename, content }: { filename: string; content: string }) =>
			api.put<ProjectDoc>(`/api/companies/${companyId}/projects/${projectId}/docs/${filename}`, {
				content,
			}),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: ['companies', companyId, 'projects', projectId, 'docs'],
			}),
	});
}

export function useDeleteProjectDoc(companyId: string, projectId: string) {
	return useMutation({
		mutationFn: (filename: string) =>
			api.delete(`/api/companies/${companyId}/projects/${projectId}/docs/${filename}`),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: ['companies', companyId, 'projects', projectId, 'docs'],
			}),
	});
}
