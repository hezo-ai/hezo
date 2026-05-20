import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export interface KbDoc {
	id: string;
	team_id: string;
	title: string;
	slug: string;
	content: string | null;
	last_updated_by_member_id: string | null;
	created_at: string;
	updated_at: string;
	last_updated_by_name: string | null;
}

export function useKbDocs(teamId: string) {
	return useQuery({
		queryKey: ['teams', teamId, 'kb-docs'],
		queryFn: () => api.get<KbDoc[]>(`/api/teams/${teamId}/kb-docs`),
	});
}

export function useKbDoc(teamId: string, slug: string) {
	return useQuery({
		queryKey: ['teams', teamId, 'kb-docs', slug],
		queryFn: () => api.get<KbDoc>(`/api/teams/${teamId}/kb-docs/${slug}`),
	});
}

export function useCreateKbDoc(teamId: string) {
	return useMutation({
		mutationFn: (data: { title: string; content?: string; slug?: string }) =>
			api.post<KbDoc>(`/api/teams/${teamId}/kb-docs`, data),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'kb-docs'] }),
	});
}

export function useUpdateKbDoc(teamId: string, slug: string) {
	return useMutation({
		mutationFn: (data: { title?: string; content?: string; change_summary?: string }) =>
			api.patch<KbDoc>(`/api/teams/${teamId}/kb-docs/${slug}`, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'kb-docs'] });
			queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'kb-docs', slug] });
		},
	});
}

export interface KbDocRevision {
	id: string;
	doc_id: string;
	revision_number: number;
	content: string;
	change_summary: string;
	author_member_id: string | null;
	author_name: string | null;
	created_at: string;
}

export function useKbDocRevisions(teamId: string, slug: string) {
	return useQuery({
		queryKey: ['teams', teamId, 'kb-docs', slug, 'revisions'],
		queryFn: () => api.get<KbDocRevision[]>(`/api/teams/${teamId}/kb-docs/${slug}/revisions`),
		enabled: !!slug,
	});
}

export function useRestoreKbDocRevision(teamId: string, slug: string) {
	return useMutation({
		mutationFn: (revisionNumber: number) =>
			api.post<KbDoc>(`/api/teams/${teamId}/kb-docs/${slug}/restore`, {
				revision_number: revisionNumber,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'kb-docs'] });
			queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'kb-docs', slug] });
			queryClient.invalidateQueries({
				queryKey: ['teams', teamId, 'kb-docs', slug, 'revisions'],
			});
		},
	});
}

export function useDeleteKbDoc(teamId: string) {
	return useMutation({
		mutationFn: (slug: string) => api.delete(`/api/teams/${teamId}/kb-docs/${slug}`),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'kb-docs'] }),
	});
}
