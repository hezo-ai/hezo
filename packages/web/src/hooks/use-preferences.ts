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

export function useUpdatePreferences(companyId: string) {
	return useMutation({
		mutationFn: (data: { content: string; change_summary?: string }) =>
			api.patch<Preferences>(`/api/companies/${companyId}/preferences`, data),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'preferences'] }),
	});
}
