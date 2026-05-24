import { useMutation, useQueries, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { useOptimisticMutation } from './use-optimistic-mutation';
import type { Team } from './use-teams';

export interface Project {
	id: string;
	team_id: string;
	name: string;
	slug: string;
	task_prefix: string;
	description: string;
	is_internal?: boolean;
	docker_base_image: string | null;
	container_id: string | null;
	container_status: 'creating' | 'running' | 'stopping' | 'stopped' | 'error' | null;
	container_error: string | null;
	container_last_logs: string | null;
	dev_ports: Array<{ container: number; host: number }>;
	repo_count: number;
	open_task_count: number;
	created_at: string;
	repos?: Repo[];
	planning_task_id?: string;
	planning_task_identifier?: string;
}

export interface Repo {
	id: string;
	project_id: string;
	short_name: string;
	repo_identifier: string;
	host_type: string;
	created_at: string;
	is_designated?: boolean;
}

export function useProjects(teamId: string) {
	return useQuery({
		queryKey: ['teams', teamId, 'projects'],
		queryFn: () => api.get<Project[]>(`/api/teams/${teamId}/projects`),
		staleTime: 0,
		refetchOnMount: 'always',
	});
}

export type ProjectWithTeam = Project & { teamSlug: string; teamName: string };

/** User-facing projects across all teams (excludes internal e.g. Operations). */
export function useAllVisibleProjects(teams: Team[] | undefined) {
	const queries = useQueries({
		queries: (teams ?? []).map((team) => ({
			queryKey: ['teams', team.slug, 'projects'],
			queryFn: () => api.get<Project[]>(`/api/teams/${team.slug}/projects`),
		})),
	});

	const isLoading = queries.some((q) => q.isLoading);
	const projects: ProjectWithTeam[] = [];

	for (let i = 0; i < queries.length; i++) {
		const team = teams?.[i];
		if (!team) continue;
		for (const p of queries[i].data ?? []) {
			if (p.is_internal) continue;
			projects.push({ ...p, teamSlug: team.slug, teamName: team.name });
		}
	}

	projects.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

	return { projects, isLoading };
}

export function useProject(teamId: string, projectId: string, options?: { enabled?: boolean }) {
	return useQuery({
		queryKey: ['teams', teamId, 'projects', projectId],
		queryFn: () => api.get<Project>(`/api/teams/${teamId}/projects/${projectId}`),
		enabled: options?.enabled,
	});
}

export function useCreateProject(teamId: string) {
	return useMutation({
		mutationFn: (data: {
			name: string;
			description: string;
			initial_prd?: string;
			task_prefix?: string;
		}) => api.post<Project>(`/api/teams/${teamId}/projects`, data),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'projects'] }),
	});
}

export function useUpdateProject(teamId: string, projectId: string) {
	return useOptimisticMutation<{ name?: string; description?: string }, Project, Project>({
		mutationFn: (data) => api.patch<Project>(`/api/teams/${teamId}/projects/${projectId}`, data),
		queryKey: ['teams', teamId, 'projects', projectId],
		applyOptimistic: (current, vars) => (current ? { ...current, ...vars } : current),
		mergeResponse: (current, updated) => (current ? { ...current, ...updated } : current),
		invalidateOnSettled: [['teams', teamId, 'projects']],
		errorMessage: 'Failed to update project',
	});
}

export function useDeleteProject(teamId: string) {
	return useMutation({
		mutationFn: (projectId: string) => api.delete(`/api/teams/${teamId}/projects/${projectId}`),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'projects'] }),
	});
}
