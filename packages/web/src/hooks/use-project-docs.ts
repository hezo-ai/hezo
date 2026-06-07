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

export function useProjectDocs(projectId: string) {
	return useQuery({
		queryKey: ['projects', projectId, 'docs'],
		queryFn: () => api.get<ProjectDoc[]>(`/api/projects/${projectId}/docs`),
		enabled: !!projectId,
	});
}

export function useProjectDoc(projectId: string, filename: string | null) {
	return useQuery({
		queryKey: ['projects', projectId, 'docs', filename],
		queryFn: () => api.get<ProjectDoc>(`/api/projects/${projectId}/docs/${filename}`),
		enabled: !!filename,
	});
}

export function useUpdateProjectDoc(projectId: string) {
	return useMutation({
		mutationFn: ({ filename, content }: { filename: string; content: string }) =>
			api.put<ProjectDoc>(`/api/projects/${projectId}/docs/${filename}`, {
				content,
			}),
		onSuccess: (saved, { filename }) => {
			queryClient.setQueryData<ProjectDoc>(['projects', projectId, 'docs', filename], saved);
			queryClient.setQueryData<ProjectDoc[]>(['projects', projectId, 'docs'], (prev) => {
				if (!prev) return [saved];
				const idx = prev.findIndex((d) => d.filename === filename);
				if (idx === -1) return [...prev, saved];
				const next = [...prev];
				next[idx] = saved;
				return next;
			});
			queryClient.invalidateQueries({
				queryKey: ['projects', projectId, 'docs'],
			});
			queryClient.invalidateQueries({
				queryKey: ['projects', projectId, 'docs', filename, 'revisions'],
			});
		},
	});
}

export function useDeleteProjectDoc(projectId: string) {
	return useMutation({
		mutationFn: (filename: string) => api.delete(`/api/projects/${projectId}/docs/${filename}`),
		onSuccess: (_data, filename) => {
			queryClient.setQueryData<ProjectDoc[]>(['projects', projectId, 'docs'], (prev) =>
				prev ? prev.filter((d) => d.filename !== filename) : prev,
			);
			queryClient.invalidateQueries({
				queryKey: ['projects', projectId, 'docs'],
			});
		},
	});
}

export function useProjectAgentsMd(projectId: string) {
	return useQuery({
		queryKey: ['projects', projectId, 'agents-md'],
		queryFn: async () => {
			try {
				return await api.get<ProjectAgentsMd>(`/api/projects/${projectId}/agents-md`);
			} catch (e) {
				if ((e as ApiError).status === 404) return null;
				throw e;
			}
		},
		enabled: !!projectId,
	});
}

export function useProjectDocRevisions(projectId: string, filename: string | null) {
	return useQuery({
		queryKey: ['projects', projectId, 'docs', filename, 'revisions'],
		queryFn: () =>
			api.get<ProjectDocRevision[]>(`/api/projects/${projectId}/docs/${filename}/revisions`),
		enabled: !!filename,
	});
}

export function useRestoreProjectDocRevision(projectId: string, filename: string) {
	return useMutation({
		mutationFn: (revisionNumber: number) =>
			api.post<ProjectDoc>(`/api/projects/${projectId}/docs/${filename}/restore`, {
				revision_number: revisionNumber,
			}),
		onSuccess: (restored) => {
			queryClient.setQueryData<ProjectDoc>(['projects', projectId, 'docs', filename], restored);
			queryClient.invalidateQueries({
				queryKey: ['projects', projectId, 'docs'],
			});
			queryClient.invalidateQueries({
				queryKey: ['projects', projectId, 'docs', filename],
			});
			queryClient.invalidateQueries({
				queryKey: ['projects', projectId, 'docs', filename, 'revisions'],
			});
		},
	});
}

export function useUpdateProjectAgentsMd(projectId: string) {
	return useMutation({
		mutationFn: (content: string) =>
			api.put<ProjectAgentsMd>(`/api/projects/${projectId}/agents-md`, {
				content,
			}),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: ['projects', projectId, 'agents-md'],
			}),
	});
}
