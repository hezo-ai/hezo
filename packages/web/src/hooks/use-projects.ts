import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';
import { useSimpleOptimisticUpdate } from './use-optimistic-mutation';
import { useRouteProjectId } from './use-route-project-id';

export interface Project {
	id: string;
	team_id: string;
	team_slug: string;
	team_name: string;
	name: string;
	slug: string;
	task_prefix: string;
	description: string;
	is_internal?: boolean;
	max_concurrent_runs: number;
	memory_limit_gib: number;
	daily_budget_cents: number;
	weekly_budget_cents: number;
	monthly_budget_cents: number;
	docker_base_image: string | null;
	container_id: string | null;
	container_status: 'creating' | 'running' | 'stopping' | 'stopped' | 'error' | null;
	container_error: string | null;
	container_last_logs: string | null;
	dev_ports: Array<{ container: number; host: number }>;
	repo_count: number;
	open_task_count: number;
	/** Total Agent members on this project's team (the hired roster size). */
	agent_count: number;
	/** Agents currently running on this project's team (runtime_status = active). */
	running_agents_count: number;
	/** Spend on this project so far today (UTC), in cents. */
	today_spend_cents: number;
	/** Most recent task update, falling back to the project's creation time. */
	last_activity_at: string;
	created_at: string;
	repos?: Repo[];
	planning_task_id?: string;
	planning_task_identifier?: string;
}

export interface Repo {
	id: string;
	project_id: string;
	repo_identifier: string;
	host_type: string;
	created_at: string;
	is_designated?: boolean;
}

export type ProjectWithTeam = Project & { teamSlug: string; teamName: string };

/**
 * The instance-wide project index: every project the caller can see across all
 * their teams, including the per-team internal projects. The single source the
 * rail, the project→team resolution, and realtime invalidation all read from.
 */
export function useProjectsIndex() {
	return useQuery({
		queryKey: queryKeys.projects.all(),
		queryFn: () => api.get<Project[]>('/api/projects'),
		staleTime: 0,
		refetchOnMount: 'always',
	});
}

/** User-facing projects across all teams (excludes internal projects). */
export function useAllVisibleProjects() {
	const { data, isLoading } = useProjectsIndex();
	const projects: ProjectWithTeam[] = (data ?? [])
		.filter((p) => !p.is_internal)
		.map((p) => ({ ...p, teamSlug: p.team_slug, teamName: p.team_name }))
		.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
	return { projects, isLoading };
}

/** The single instance-wide internal project (HQ), resolved from the index. */
export function useHqProject(): Project | undefined {
	const { data } = useProjectsIndex();
	return (data ?? []).find((p) => p.is_internal);
}

/** The project (incl. internal) matching a slug, resolved from the index. */
export function useProjectMeta(projectSlug: string | null | undefined): Project | undefined {
	const { data } = useProjectsIndex();
	if (!projectSlug) return undefined;
	return (data ?? []).find((p) => p.slug === projectSlug || p.id === projectSlug);
}

export interface ResolvedTeam {
	teamSlug: string;
	teamId: string;
	teamName: string;
}

/**
 * The backing team for a project slug. Defaults to the current route's project.
 * Returns null until the index has loaded or when off any project. Team is an
 * implementation detail resolved from the project — never named in the URL.
 */
export function useResolvedTeam(projectSlug?: string): ResolvedTeam | null {
	const routeProjectId = useRouteProjectId();
	const slug = projectSlug ?? routeProjectId;
	const project = useProjectMeta(slug);
	if (!project) return null;
	return { teamSlug: project.team_slug, teamId: project.team_id, teamName: project.team_name };
}

export function useProject(projectId: string, options?: { enabled?: boolean }) {
	return useQuery({
		queryKey: queryKeys.projects.detail(projectId),
		queryFn: () => api.get<Project>(`/api/projects/${projectId}`),
		enabled: options?.enabled,
	});
}

export interface ProjectWithTeamResponse {
	id: string;
	slug: string;
	name: string;
	team_id: string;
	team_slug: string;
	docker_base_image: string;
	planning_task_id: string;
	planning_task_identifier: string;
}

/**
 * Projects-primary creation: a project owns its own team (1:1). Calls
 * POST /api/projects, which provisions a fresh team from the chosen team-type
 * template (default Blank) — or, when `source_team_id` is given, from a fresh
 * snapshot of an existing team — and directly creates the project + planning
 * task. See .dev/architecture.md.
 */
export function useCreateProjectWithTeam() {
	return useMutation({
		mutationFn: (data: {
			name: string;
			description: string;
			template_id?: string;
			source_team_id?: string;
			initial_prd?: string;
			task_prefix?: string;
		}) => api.post<ProjectWithTeamResponse>('/api/projects', data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.all() });
			// Cloning a team mints a new reusable template — refresh the catalog.
			queryClient.invalidateQueries({ queryKey: queryKeys.teamTemplates() });
		},
	});
}

interface UpdateProjectVars {
	name?: string;
	description?: string;
	max_concurrent_runs?: number;
	memory_limit_gib?: number;
	daily_budget_cents?: number;
	weekly_budget_cents?: number;
	monthly_budget_cents?: number;
}

export function useUpdateProject(projectId: string) {
	return useSimpleOptimisticUpdate<Project, UpdateProjectVars>(
		`/api/projects/${projectId}`,
		queryKeys.projects.detail(projectId),
		{
			// budgetStatus carries the per-window limits the Budget page KPI cards read,
			// so a budget-limit edit must refetch it (the optimistic update only touches
			// the project detail cache).
			invalidateOnSettled: [queryKeys.projects.all(), queryKeys.projects.budgetStatus(projectId)],
			errorMessage: 'Failed to update project',
		},
	);
}

export function useDeleteProject() {
	return useMutation({
		mutationFn: (projectId: string) => api.delete(`/api/projects/${projectId}`),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.projects.all() }),
	});
}
