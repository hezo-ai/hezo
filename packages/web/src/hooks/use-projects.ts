import type { ProjectProgress } from '@hezo/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type ApiError, api } from '../lib/api';
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
	/** Active (non-archived) goals on this project; drives the sidebar "no goals yet" dot.
	 * Carried on both the project index and the single-project detail payload. Optional because
	 * older/partial payloads may omit it. */
	open_goal_count?: number;
	/** Total Agent members on this project's team (the hired roster size). */
	agent_count: number;
	/** Agents currently running on this project's team (runtime_status = active). */
	running_agents_count: number;
	/** Spend on this project so far today (UTC), in cents. */
	today_spend_cents: number;
	/** Most recent task update, falling back to the project's creation time. */
	last_activity_at: string;
	created_at: string;
	/** When the project was archived (soft-deleted), or null/absent when active.
	 * Archived projects are excluded from the default index that backs the rail. */
	archived_at?: string | null;
	/** Signed URL for the project's icon image, or null when none is set. */
	icon_url?: string | null;
	/** When the icon was last set (drives the `<img>` cache version), or null. */
	icon_updated_at?: string | null;
	repos?: Repo[];
	planning_task_id?: string;
	planning_task_identifier?: string;
	/** Captain-maintained progress summary (markdown). Present on the project detail payload. */
	progress_summary?: string;
	progress_summary_updated_at?: string | null;
}

export interface Repo {
	id: string;
	project_id: string;
	repo_identifier: string;
	host_type: string;
	created_at: string;
	is_designated?: boolean;
	/** Background checkout setup lifecycle; the row settles via WebSocket UPDATE. */
	setup_status?: 'pending' | 'ready' | 'failed';
	setup_error?: string | null;
}

export type ProjectWithTeam = Project & { teamSlug: string; teamName: string };

/**
 * Container states that always resolve on their own, so a UI parked on one is
 * waiting for a transition it must not miss. Deliberately excludes the `null`
 * status: a torn-down project sits at `null` indefinitely and would poll forever.
 */
const TRANSIENT_CONTAINER_STATUSES = new Set(['creating', 'stopping']);

/** How often to re-check the index while a container is mid-transition. */
const TRANSIENT_CONTAINER_POLL_MS = 10_000;

/**
 * The instance-wide project index: every project the caller can see across all
 * their teams, including the per-team internal projects. The single source the
 * rail, the project→team resolution, and realtime invalidation all read from.
 *
 * The container status banner and the CEO chat's HQ gate both read their health
 * from here, and provisioning ends with a single `projects` row-change broadcast.
 * That event has no replay — a socket that hasn't joined the team room yet (the
 * rooms are derived from this very query, so there is a window between its
 * response and the join) drops it, and the UI then shows "provisioning" until a
 * full reload. Poll while any container is in a transient state so the UI
 * converges on its own; the interval switches off once everything has settled.
 */
export function useProjectsIndex() {
	return useQuery({
		queryKey: queryKeys.projects.all(),
		queryFn: () => api.get<Project[]>('/api/projects'),
		staleTime: 0,
		refetchOnMount: 'always',
		refetchInterval: (query) =>
			(query.state.data ?? []).some(
				(p) => p.container_status && TRANSIENT_CONTAINER_STATUSES.has(p.container_status),
			)
				? TRANSIENT_CONTAINER_POLL_MS
				: false,
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

/** The Captain-maintained progress summary shown at the top of the Progress page. */
export function useProjectProgress(projectId: string, options?: { enabled?: boolean }) {
	return useQuery({
		queryKey: queryKeys.projects.progress(projectId),
		queryFn: () => api.get<ProjectProgress>(`/api/projects/${projectId}/progress`),
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
			marketplace_slug?: string;
			initial_project_plan?: string;
			task_prefix?: string;
		}) => api.post<ProjectWithTeamResponse>('/api/projects', data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.all(), exact: true });
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
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.all(), exact: true }),
	});
}

/** Archived projects (global settings "Archived projects" page). Superuser-only. */
export function useArchivedProjects() {
	return useQuery({
		queryKey: queryKeys.projects.archived(),
		queryFn: () => api.get<Project[]>('/api/projects?filter=archived'),
		staleTime: 0,
		refetchOnMount: 'always',
	});
}

/**
 * Archive a project: soft-hides it from the rail and stops its container.
 * Invalidate-driven (not optimistic) — the server has side effects (container
 * teardown) and the project leaves the rail. Refetches both the rail index and
 * the archived list (invalidating the `['projects']` prefix covers both).
 */
export function useArchiveProject(projectId: string) {
	return useMutation({
		mutationFn: () => api.post(`/api/projects/${projectId}/archive`, {}),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.projects.all() }),
	});
}

/** Unarchive a project: restores it to the rail. Container stays stopped. */
export function useUnarchiveProject(projectId: string) {
	return useMutation({
		mutationFn: () => api.post(`/api/projects/${projectId}/unarchive`, {}),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.projects.all() }),
	});
}

export interface ProjectIconResponse {
	icon_url: string | null;
	icon_updated_at: string | null;
}

/**
 * Seed the icon fields into the cached project detail + index from a server
 * response, so the rail and settings reflect the change immediately rather than
 * waiting for the invalidated queries to refetch (which races under load). The
 * server returns the signed `icon_url`, so this is response-driven, not optimistic.
 */
function applyIconToCaches(projectId: string, icon: ProjectIconResponse) {
	queryClient.setQueryData<Project>(queryKeys.projects.detail(projectId), (old) =>
		old ? { ...old, icon_url: icon.icon_url, icon_updated_at: icon.icon_updated_at } : old,
	);
	queryClient.setQueryData<Project[]>(queryKeys.projects.all(), (old) =>
		old?.map((p) =>
			p.slug === projectId || p.id === projectId
				? { ...p, icon_url: icon.icon_url, icon_updated_at: icon.icon_updated_at }
				: p,
		),
	);
	// Reconcile against the server (e.g. exact timestamps) without blocking the UI.
	queryClient.invalidateQueries({ queryKey: queryKeys.projects.all(), exact: true });
	queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) });
}

/**
 * Upload (or replace) a project's icon. `blob` is the already-normalized square
 * PNG produced client-side. The response carries the signed `icon_url`, which we
 * write straight into the project caches so the rail and settings update at once.
 */
export function useUploadProjectIcon(projectId: string) {
	return useMutation<ProjectIconResponse, ApiError, Blob>({
		mutationFn: (blob) => {
			const fd = new FormData();
			fd.set('file', blob, 'icon.png');
			return api.putForm<ProjectIconResponse>(`/api/projects/${projectId}/icon`, fd);
		},
		onSuccess: (data) => applyIconToCaches(projectId, data),
	});
}

export function useRemoveProjectIcon(projectId: string) {
	return useMutation<ProjectIconResponse, ApiError, void>({
		mutationFn: () => api.delete<ProjectIconResponse>(`/api/projects/${projectId}/icon`),
		onSuccess: () => applyIconToCaches(projectId, { icon_url: null, icon_updated_at: null }),
	});
}
