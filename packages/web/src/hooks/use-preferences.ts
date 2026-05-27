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

export function usePreferences(teamId: string) {
	return useQuery({
		queryKey: ['teams', teamId, 'preferences'],
		queryFn: () => api.get<Preferences | null>(`/api/teams/${teamId}/preferences`),
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

export function usePreferenceRevisions(teamId: string) {
	return useQuery({
		queryKey: ['teams', teamId, 'preferences', 'revisions'],
		queryFn: () => api.get<PreferenceRevision[]>(`/api/teams/${teamId}/preferences/revisions`),
	});
}

export function useUpdatePreferences(teamId: string) {
	return useOptimisticMutation<
		{ content: string; change_summary?: string },
		Preferences,
		Preferences | null
	>({
		mutationFn: (data) => api.patch<Preferences>(`/api/teams/${teamId}/preferences`, data),
		queryKey: ['teams', teamId, 'preferences'],
		applyOptimistic: (current, { content }) => (current ? { ...current, content } : current),
		mergeResponse: (current, updated) => (current ? { ...current, ...updated } : updated),
		invalidateOnSettled: [['teams', teamId, 'preferences', 'revisions']],
		errorMessage: 'Failed to update preferences',
	});
}

export function useRestorePreferenceRevision(teamId: string) {
	return useMutation({
		mutationFn: (revisionNumber: number) =>
			api.post<Preferences>(`/api/teams/${teamId}/preferences/restore`, {
				revision_number: revisionNumber,
			}),
		onSuccess: (restored) => {
			queryClient.setQueryData<Preferences | null>(['teams', teamId, 'preferences'], restored);
			queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'preferences'] });
			queryClient.invalidateQueries({
				queryKey: ['teams', teamId, 'preferences', 'revisions'],
			});
		},
	});
}
