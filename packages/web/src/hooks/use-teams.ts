import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export interface TeamSettings {
	wake_mentioner_on_reply?: boolean;
	subtask_page_size?: number;
	[key: string]: unknown;
}

export const DEFAULT_SUBTASK_PAGE_SIZE = 10;

export interface Team {
	id: string;
	name: string;
	slug: string;
	description: string | null;
	summary: string | null;
	team_type_ids: string[];
	mcp_servers: unknown[];
	settings: TeamSettings;
	agent_count: number;
	open_issue_count: number;
	created_at: string;
}

export function useTeam(id: string, enabled = true) {
	return useQuery({
		queryKey: ['teams', id],
		queryFn: () => api.get<Team>(`/api/teams/${id}`),
		enabled,
	});
}

export function useUpdateTeam(id: string) {
	return useMutation({
		mutationFn: (data: {
			name?: string;
			description?: string;
			mcp_servers?: unknown[];
			settings?: Partial<TeamSettings>;
		}) => api.patch<Team>(`/api/teams/${id}`, data),
		onSuccess: (updated) => {
			queryClient.setQueryData(['teams', id], updated);
			queryClient.invalidateQueries({ queryKey: ['teams'] });
		},
	});
}
