import { useMutation, useQuery } from '@tanstack/react-query';
import type { DocumentRevision } from '../components/revisions-panel';
import { type ApiError, api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export interface ProjectDoc {
	id: string;
	filename: string;
	updated_at: string;
	content?: string;
}

export type ProjectDocRevision = DocumentRevision;

export interface ProjectAgentsMd {
	filename: string;
	content: string;
}

export function useProjectDocs(companyId: string, projectId: string) {
	return useQuery({
		queryKey: ['companies', companyId, 'projects', projectId, 'docs'],
		queryFn: () => api.get<ProjectDoc[]>(`/api/companies/${companyId}/projects/${projectId}/docs`),
		enabled: !!projectId,
	});
}

export function useProjectDoc(companyId: string, projectId: string, filename: string | null) {
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
		onSuccess: (_data, { filename }) => {
			queryClient.invalidateQueries({
				queryKey: ['companies', companyId, 'projects', projectId, 'docs'],
			});
			queryClient.invalidateQueries({
				queryKey: ['companies', companyId, 'projects', projectId, 'docs', filename],
			});
		},
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

export function useProjectAgentsMd(companyId: string, projectId: string) {
	return useQuery({
		queryKey: ['companies', companyId, 'projects', projectId, 'agents-md'],
		queryFn: async () => {
			try {
				return await api.get<ProjectAgentsMd>(
					`/api/companies/${companyId}/projects/${projectId}/agents-md`,
				);
			} catch (e) {
				if ((e as ApiError).status === 404) return null;
				throw e;
			}
		},
		enabled: !!projectId,
	});
}

export function useProjectDocRevisions(
	companyId: string,
	projectId: string,
	filename: string | null,
) {
	return useQuery({
		queryKey: ['companies', companyId, 'projects', projectId, 'docs', filename, 'revisions'],
		queryFn: () =>
			api.get<ProjectDocRevision[]>(
				`/api/companies/${companyId}/projects/${projectId}/docs/${filename}/revisions`,
			),
		enabled: !!filename,
	});
}

export function useRestoreProjectDocRevision(
	companyId: string,
	projectId: string,
	filename: string,
) {
	return useMutation({
		mutationFn: (revisionNumber: number) =>
			api.post<ProjectDoc>(
				`/api/companies/${companyId}/projects/${projectId}/docs/${filename}/restore`,
				{ revision_number: revisionNumber },
			),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ['companies', companyId, 'projects', projectId, 'docs'],
			});
			queryClient.invalidateQueries({
				queryKey: ['companies', companyId, 'projects', projectId, 'docs', filename],
			});
			queryClient.invalidateQueries({
				queryKey: ['companies', companyId, 'projects', projectId, 'docs', filename, 'revisions'],
			});
		},
	});
}

export function useUpdateProjectAgentsMd(companyId: string, projectId: string) {
	return useMutation({
		mutationFn: (content: string) =>
			api.put<ProjectAgentsMd>(`/api/companies/${companyId}/projects/${projectId}/agents-md`, {
				content,
			}),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: ['companies', companyId, 'projects', projectId, 'agents-md'],
			}),
	});
}
