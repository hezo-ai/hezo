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

export function useUiState(teamId: string) {
	return useQuery({
		queryKey: ['teams', teamId, 'ui-state'],
		queryFn: () => api.get<UiState>(`/api/teams/${teamId}/ui-state`),
		staleTime: Number.POSITIVE_INFINITY,
		enabled: !!teamId,
	});
}

export function useUpdateUiState(teamId: string) {
	return useMutation({
		mutationFn: (data: UiState) => {
			const current = queryClient.getQueryData<UiState>(['teams', teamId, 'ui-state']);
			const merged: UiState = {
				...current,
				...data,
				sidebar: { ...current?.sidebar, ...data.sidebar },
			};
			return api.patch<UiState>(`/api/teams/${teamId}/ui-state`, merged);
		},
		onMutate: async (data) => {
			await queryClient.cancelQueries({ queryKey: ['teams', teamId, 'ui-state'] });
			const previous = queryClient.getQueryData<UiState>(['teams', teamId, 'ui-state']);
			queryClient.setQueryData<UiState>(['teams', teamId, 'ui-state'], (old) => ({
				...old,
				...data,
				sidebar: { ...old?.sidebar, ...data.sidebar },
			}));
			return { previous };
		},
		onError: (_err, _data, context) => {
			if (context?.previous !== undefined) {
				queryClient.setQueryData(['teams', teamId, 'ui-state'], context.previous);
			}
		},
	});
}
