import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

export function useCreateTeam() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (vars: { name: string; description?: string; template_id?: string }) =>
			api.post<Team>('/api/teams', vars),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['teams'] });
		},
	});
}

export interface SaveTeamAsTemplateResult {
	template_id: string;
	skipped_agents: string[];
}

export function useSaveTeamAsTemplate(teamSlug: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (vars: { name: string; description?: string }) =>
			api.post<SaveTeamAsTemplateResult>(`/api/teams/${teamSlug}/save-as-template`, vars),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['team-templates'] });
		},
	});
}

export interface ApplyTeamTypeResult {
	created_slugs: string[];
	skipped_slugs: string[];
	builtin_inserted_slugs: string[];
	builtin_updated_slugs: string[];
}

export function useApplyTeamType(teamSlug: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (vars: { template_id: string }) =>
			api.post<ApplyTeamTypeResult>(`/api/teams/${teamSlug}/apply-type`, vars),
		onSuccess: () => {
			// A merge can add agents — refetch the roster and team views.
			queryClient.invalidateQueries({ queryKey: ['agents'] });
			queryClient.invalidateQueries({ queryKey: ['teams'] });
		},
	});
}
