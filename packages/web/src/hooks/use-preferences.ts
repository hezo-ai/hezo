import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { useOptimisticMutation } from './use-optimistic-mutation';

export interface Preferences {
	id: string;
	team_id: string;
	content: string;
	updated_at: string;
}

export function usePreferences(projectId: string) {
	return useQuery({
		queryKey: ['projects', projectId, 'preferences'],
		queryFn: () => api.get<Preferences | null>(`/api/projects/${projectId}/preferences`),
	});
}

export interface PreferenceRevision {
	id: string;
	preference_id: string;
	revision_number: number;
	content: string;
	change_summary: string;
	author_name: string | null;
	created_at: string;
}

export function usePreferenceRevisions(projectId: string) {
	return useQuery({
		queryKey: ['projects', projectId, 'preferences', 'revisions'],
		queryFn: () =>
			api.get<PreferenceRevision[]>(`/api/projects/${projectId}/preferences/revisions`),
	});
}

export function useUpdatePreferences(projectId: string) {
	return useOptimisticMutation<
		{ content: string; change_summary?: string },
		Preferences,
		Preferences | null
	>({
		mutationFn: (data) => api.patch<Preferences>(`/api/projects/${projectId}/preferences`, data),
		queryKey: ['projects', projectId, 'preferences'],
		applyOptimistic: (current, { content }) => (current ? { ...current, content } : current),
		mergeResponse: (current, updated) => (current ? { ...current, ...updated } : updated),
		invalidateOnSettled: [['projects', projectId, 'preferences', 'revisions']],
		errorMessage: 'Failed to update preferences',
	});
}

export function useRestorePreferenceRevision(projectId: string) {
	return useMutation({
		mutationFn: (revisionNumber: number) =>
			api.post<Preferences>(`/api/projects/${projectId}/preferences/restore`, {
				revision_number: revisionNumber,
			}),
		onSuccess: (restored) => {
			queryClient.setQueryData<Preferences | null>(
				['projects', projectId, 'preferences'],
				restored,
			);
			queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'preferences'] });
			queryClient.invalidateQueries({
				queryKey: ['projects', projectId, 'preferences', 'revisions'],
			});
		},
	});
}
