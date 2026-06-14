import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/query-keys';
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
	/** True for the instance-level HQ team (owns the one is_internal project). */
	is_internal: boolean;
	mcp_servers: unknown[];
	settings: TeamSettings;
	agent_count: number;
	open_task_count: number;
	created_at: string;
}

export function useTeams() {
	return useQuery({
		queryKey: queryKeys.teams.all(),
		queryFn: () => api.get<Team[]>('/api/teams'),
	});
}

/** The backing team for a project, addressed via the project slug. */
export function useTeam(projectId: string, enabled = true) {
	return useQuery({
		queryKey: queryKeys.projects.team(projectId),
		queryFn: () => api.get<Team>(`/api/projects/${projectId}/team`),
		enabled: enabled && !!projectId,
	});
}

interface UpdateTeamVars {
	name?: string;
	description?: string;
	mcp_servers?: unknown[];
	settings?: Partial<TeamSettings>;
}

export function useUpdateTeam(projectId: string) {
	return useOptimisticMutation<UpdateTeamVars, Team, Team>({
		mutationFn: (data) => api.patch<Team>(`/api/projects/${projectId}/team`, data),
		queryKey: queryKeys.projects.team(projectId),
		applyOptimistic: (current, vars) => {
			if (!current) return current;
			return {
				...current,
				...vars,
				settings: { ...current.settings, ...(vars.settings ?? {}) },
			};
		},
		mergeResponse: (current, updated) => (current ? { ...current, ...updated } : current),
		invalidateOnSettled: [queryKeys.teams.all(), queryKeys.projects.all()],
		errorMessage: 'Failed to update team',
	});
}

export interface SaveTeamAsTemplateResult {
	template_id: string;
	skipped_agents: string[];
}

export function useSaveTeamAsTemplate(projectId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (vars: { name: string; description?: string }) =>
			api.post<SaveTeamAsTemplateResult>(`/api/projects/${projectId}/save-as-template`, vars),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.teamTemplates() });
		},
	});
}

export interface ApplyTeamTypeResult {
	created_slugs: string[];
	skipped_slugs: string[];
	builtin_inserted_slugs: string[];
	builtin_updated_slugs: string[];
}

export function useApplyTeamType(projectId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (vars: { template_id: string }) =>
			api.post<ApplyTeamTypeResult>(`/api/projects/${projectId}/apply-type`, vars),
		onSuccess: () => {
			// A merge can add agents — refetch the roster and team views.
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.all() });
			queryClient.invalidateQueries({ queryKey: queryKeys.teams.all() });
		},
	});
}
