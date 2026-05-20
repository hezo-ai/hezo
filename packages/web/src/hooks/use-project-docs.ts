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

export function useProjectDocs(teamId: string, projectId: string) {
	return useQuery({
		queryKey: ['teams', teamId, 'projects', projectId, 'docs'],
		queryFn: () => api.get<ProjectDoc[]>(`/api/teams/${teamId}/projects/${projectId}/docs`),
		enabled: !!projectId,
	});
}

export function useProjectDoc(teamId: string, projectId: string, filename: string | null) {
	return useQuery({
		queryKey: ['teams', teamId, 'projects', projectId, 'docs', filename],
		queryFn: () =>
			api.get<ProjectDoc>(`/api/teams/${teamId}/projects/${projectId}/docs/${filename}`),
		enabled: !!filename,
	});
}

export function useUpdateProjectDoc(teamId: string, projectId: string) {
	return useMutation({
		mutationFn: ({ filename, content }: { filename: string; content: string }) =>
			api.put<ProjectDoc>(`/api/teams/${teamId}/projects/${projectId}/docs/${filename}`, {
				content,
			}),
		onSuccess: (_data, { filename }) => {
			queryClient.invalidateQueries({
				queryKey: ['teams', teamId, 'projects', projectId, 'docs'],
			});
			queryClient.invalidateQueries({
				queryKey: ['teams', teamId, 'projects', projectId, 'docs', filename],
			});
		},
	});
}

export function useDeleteProjectDoc(teamId: string, projectId: string) {
	return useMutation({
		mutationFn: (filename: string) =>
			api.delete(`/api/teams/${teamId}/projects/${projectId}/docs/${filename}`),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: ['teams', teamId, 'projects', projectId, 'docs'],
			}),
	});
}

export function useProjectAgentsMd(teamId: string, projectId: string) {
	return useQuery({
		queryKey: ['teams', teamId, 'projects', projectId, 'agents-md'],
		queryFn: async () => {
			try {
				return await api.get<ProjectAgentsMd>(
					`/api/teams/${teamId}/projects/${projectId}/agents-md`,
				);
			} catch (e) {
				if ((e as ApiError).status === 404) return null;
				throw e;
			}
		},
		enabled: !!projectId,
	});
}

export function useProjectDocRevisions(teamId: string, projectId: string, filename: string | null) {
	return useQuery({
		queryKey: ['teams', teamId, 'projects', projectId, 'docs', filename, 'revisions'],
		queryFn: () =>
			api.get<ProjectDocRevision[]>(
				`/api/teams/${teamId}/projects/${projectId}/docs/${filename}/revisions`,
			),
		enabled: !!filename,
	});
}

export function useRestoreProjectDocRevision(teamId: string, projectId: string, filename: string) {
	return useMutation({
		mutationFn: (revisionNumber: number) =>
			api.post<ProjectDoc>(`/api/teams/${teamId}/projects/${projectId}/docs/${filename}/restore`, {
				revision_number: revisionNumber,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ['teams', teamId, 'projects', projectId, 'docs'],
			});
			queryClient.invalidateQueries({
				queryKey: ['teams', teamId, 'projects', projectId, 'docs', filename],
			});
			queryClient.invalidateQueries({
				queryKey: ['teams', teamId, 'projects', projectId, 'docs', filename, 'revisions'],
			});
		},
	});
}

export function useUpdateProjectAgentsMd(teamId: string, projectId: string) {
	return useMutation({
		mutationFn: (content: string) =>
			api.put<ProjectAgentsMd>(`/api/teams/${teamId}/projects/${projectId}/agents-md`, {
				content,
			}),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: ['teams', teamId, 'projects', projectId, 'agents-md'],
			}),
	});
}
