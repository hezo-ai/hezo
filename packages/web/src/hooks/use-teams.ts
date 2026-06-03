import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useOptimisticMutation } from './use-optimistic-mutation';

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
	/** Name of the team template this team was created from ("its type"), or null. */
	primary_template_name: string | null;
	mcp_servers: unknown[];
	settings: TeamSettings;
	agent_count: number;
	open_task_count: number;
	created_at: string;
}

export function useTeams() {
	return useQuery({
		queryKey: ['teams'],
		queryFn: () => api.get<Team[]>('/api/teams'),
	});
}

export function useTeam(id: string, enabled = true) {
	return useQuery({
		queryKey: ['teams', id],
		queryFn: () => api.get<Team>(`/api/teams/${id}`),
		enabled,
	});
}

interface UpdateTeamVars {
	name?: string;
	description?: string;
	mcp_servers?: unknown[];
	settings?: Partial<TeamSettings>;
}

export function useUpdateTeam(id: string) {
	return useOptimisticMutation<UpdateTeamVars, Team, Team>({
		mutationFn: (data) => api.patch<Team>(`/api/teams/${id}`, data),
		queryKey: ['teams', id],
		applyOptimistic: (current, vars) => {
			if (!current) return current;
			return {
				...current,
				...vars,
				settings: { ...current.settings, ...(vars.settings ?? {}) },
			};
		},
		mergeResponse: (current, updated) => (current ? { ...current, ...updated } : current),
		invalidateOnSettled: [['teams']],
		errorMessage: 'Failed to update team',
	});
}
