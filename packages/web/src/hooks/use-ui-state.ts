import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

interface SidebarState {
	team_expanded?: boolean;
	projects_expanded?: boolean;
	collapsed?: boolean;
}

export interface UiState {
	sidebar?: SidebarState;
}

export function useUiState(companyId: string) {
	return useQuery({
		queryKey: ['companies', companyId, 'ui-state'],
		queryFn: () => api.get<UiState>(`/api/companies/${companyId}/ui-state`),
		staleTime: Number.POSITIVE_INFINITY,
		enabled: !!companyId,
	});
}

export function useUpdateUiState(companyId: string) {
	return useMutation({
		mutationFn: (data: UiState) => {
			const current = queryClient.getQueryData<UiState>(['companies', companyId, 'ui-state']);
			const merged: UiState = {
				...current,
				...data,
				sidebar: { ...current?.sidebar, ...data.sidebar },
			};
			return api.patch<UiState>(`/api/companies/${companyId}/ui-state`, merged);
		},
		onMutate: async (data) => {
			await queryClient.cancelQueries({ queryKey: ['companies', companyId, 'ui-state'] });
			const previous = queryClient.getQueryData<UiState>(['companies', companyId, 'ui-state']);
			queryClient.setQueryData<UiState>(['companies', companyId, 'ui-state'], (old) => ({
				...old,
				...data,
				sidebar: { ...old?.sidebar, ...data.sidebar },
			}));
			return { previous };
		},
		onError: (_err, _data, context) => {
			if (context?.previous !== undefined) {
				queryClient.setQueryData(['companies', companyId, 'ui-state'], context.previous);
			}
		},
	});
}
