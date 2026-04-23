import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export interface Preferences {
	id: string;
	company_id: string;
	content: string;
	updated_at: string;
}

export function usePreferences(companyId: string) {
	return useQuery({
		queryKey: ['companies', companyId, 'preferences'],
		queryFn: () => api.get<Preferences | null>(`/api/companies/${companyId}/preferences`),
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

export function usePreferenceRevisions(companyId: string) {
	return useQuery({
		queryKey: ['companies', companyId, 'preferences', 'revisions'],
		queryFn: () =>
			api.get<PreferenceRevision[]>(`/api/companies/${companyId}/preferences/revisions`),
	});
}

export function useUpdatePreferences(companyId: string) {
	return useMutation({
		mutationFn: (data: { content: string; change_summary?: string }) =>
			api.patch<Preferences>(`/api/companies/${companyId}/preferences`, data),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'preferences'] }),
	});
}

export function useRestorePreferenceRevision(companyId: string) {
	return useMutation({
		mutationFn: (revisionNumber: number) =>
			api.post<Preferences>(`/api/companies/${companyId}/preferences/restore`, {
				revision_number: revisionNumber,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'preferences'] });
			queryClient.invalidateQueries({
				queryKey: ['companies', companyId, 'preferences', 'revisions'],
			});
		},
	});
}
