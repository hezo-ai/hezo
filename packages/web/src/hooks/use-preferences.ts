import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';
import { useOptimisticMutation } from './use-optimistic-mutation';

export interface Preferences {
	id: string;
	team_id: string;
	content: string;
	updated_at: string;
}

export function usePreferences(projectId: string) {
	return useQuery({
		queryKey: queryKeys.projects.preferences(projectId),
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
		queryKey: queryKeys.projects.preferencesRevisions(projectId),
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
		queryKey: queryKeys.projects.preferences(projectId),
		applyOptimistic: (current, { content }) => (current ? { ...current, content } : current),
		mergeResponse: (current, updated) => (current ? { ...current, ...updated } : updated),
		invalidateOnSettled: [queryKeys.projects.preferencesRevisions(projectId)],
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
				queryKeys.projects.preferences(projectId),
				restored,
			);
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.preferences(projectId) });
			queryClient.invalidateQueries({
				queryKey: queryKeys.projects.preferencesRevisions(projectId),
			});
		},
	});
}
