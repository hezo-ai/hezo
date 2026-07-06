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

export type RepoGitState =
	| { container_running: false }
	| { container_running: true; clone: CloneState; worktrees: GitWorktree[] };

export type ResetAction = 'discard_local' | 'prune_worktrees' | 'reclone';

/**
 * Live git state for one repository. Lazy: pass `enabled` so the query (which does
 * live docker execs in the container) fires only when the panel is expanded.
 */
export function useRepoGitState(projectId: string, repoId: string, enabled: boolean) {
	return useQuery({
		queryKey: queryKeys.projects.gitState(projectId, repoId),
		queryFn: () => api.get<RepoGitState>(`/api/projects/${projectId}/repos/${repoId}/git-state`),
		enabled,
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
