import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { useOptimisticMutation } from './use-optimistic-mutation';

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
		onSuccess: (created) => {
			queryClient.setQueryData<KbDoc[]>(['teams', teamId, 'kb-docs'], (prev) =>
				prev ? [...prev.filter((d) => d.id !== created.id), created] : [created],
			);
			queryClient.setQueryData<KbDoc>(['teams', teamId, 'kb-docs', created.slug], created);
			queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'kb-docs'] });
		},
	});
}

interface UpdateKbDocVars {
	title?: string;
	content?: string;
	change_summary?: string;
}

export function useUpdateKbDoc(teamId: string, slug: string) {
	return useOptimisticMutation<UpdateKbDocVars, KbDoc, KbDoc>({
		mutationFn: (data) => api.patch<KbDoc>(`/api/teams/${teamId}/kb-docs/${slug}`, data),
		queryKey: ['teams', teamId, 'kb-docs', slug],
		applyOptimistic: (current, vars) => {
			if (!current) return current;
			// change_summary is for the revision history, not the doc body.
			const { change_summary: _summary, ...optimistic } = vars;
			return { ...current, ...optimistic };
		},
		mergeResponse: (current, updated) => (current ? { ...current, ...updated } : current),
		invalidateOnSettled: [
			['teams', teamId, 'kb-docs'],
			['teams', teamId, 'kb-docs', slug, 'revisions'],
		],
		errorMessage: 'Failed to update doc',
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
		onSuccess: (restored) => {
			queryClient.setQueryData<KbDoc>(['teams', teamId, 'kb-docs', slug], restored);
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
		onSuccess: (_, slug) => {
			queryClient.setQueryData<KbDoc[]>(['teams', teamId, 'kb-docs'], (prev) =>
				prev ? prev.filter((d) => d.slug !== slug) : prev,
			);
			queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'kb-docs'] });
		},
	});
}
