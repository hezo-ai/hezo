import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';

/** Local git state of a repository clone (read live from the project container). */
export interface CloneState {
	cloned: boolean;
	/** Remote default branch (origin/HEAD → main/master), the branch sync fast-forwards. */
	defaultBranch: string | null;
	/** Currently checked-out branch in the clone (null if detached). */
	headBranch: string | null;
	/** HEAD commit sha, or null for an unborn HEAD (repo with no commits). */
	head: string | null;
	dirty: boolean;
	/** Commits on HEAD not on origin/<default>; null when it can't be computed. */
	ahead: number | null;
	/** Commits on origin/<default> not on HEAD (reflects the last fetch). */
	behind: number | null;
}

export interface GitWorktree {
	taskIdentifier: string;
	branch: string | null;
	head: string | null;
	dirty: boolean;
	task: { title: string; status: string } | null;
}

export type RepoGitState = { can_push: boolean } & (
	| { container_running: false }
	| {
			container_running: true;
			clone: CloneState;
			worktrees: GitWorktree[];
			/** Queued/running agent runs on the project; reset is blocked while > 0. */
			active_runs: number;
	  }
);

export type ResetAction = 'discard_local' | 'prune_worktrees' | 'reclone';

/**
 * Live git state for one repository. Lazy: pass `enabled` so the query (which does
 * live docker execs in the container) fires only when the panel is expanded.
 *
 * `pollMs` turns on a temporary watch while a container the panel asked for is
 * coming up. Left off the rest of the time on purpose: every call re-checks push
 * access against GitHub, so this is not a query to leave ticking.
 */
export function useRepoGitState(
	projectId: string,
	repoId: string,
	enabled: boolean,
	pollMs?: number,
) {
	return useQuery({
		queryKey: queryKeys.projects.gitState(projectId, repoId),
		queryFn: () => api.get<RepoGitState>(`/api/projects/${projectId}/repos/${repoId}/git-state`),
		enabled,
		refetchInterval: pollMs ?? false,
	});
}

/** What `POST .../git-state` answers: one was already up, or a start is under way. */
export interface RepoContainerStart {
	starting: boolean;
	container_running: boolean;
}

/** The code that route returns while the instance memory budget leaves no room. */
export const CONTAINER_AT_CAPACITY = 'CONTAINER_AT_CAPACITY';

/**
 * Ask for a container so the git state can be read.
 *
 * Invalidate-and-refetch rather than optimistic: this is container lifecycle, and
 * nothing about it is settled until the server says so.
 */
export function useStartRepoContainer(projectId: string, repoId: string) {
	return useMutation({
		mutationFn: () =>
			api.post<RepoContainerStart>(`/api/projects/${projectId}/repos/${repoId}/git-state`, {}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.gitState(projectId, repoId) });
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) });
		},
	});
}

export function useResetRepo(projectId: string, repoId: string) {
	return useMutation({
		mutationFn: (action: ResetAction) =>
			api.post<{ reset: true; action: ResetAction; warning?: string | null }>(
				`/api/projects/${projectId}/repos/${repoId}/reset`,
				{ action },
			),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.gitState(projectId, repoId) });
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.repos(projectId) });
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) });
		},
	});
}
