// Serializes git operations that mutate a repo's shared .git store (clone,
// fetch, worktree add, reset) per project. Concurrent runs on the same project
// work in separate per-task worktrees but share one .git per repo, so these
// brief setup/recovery steps must not overlap or they race on git's index/ref
// locks. Keyed by project id, so different projects never block one another.
// In-process only (single-server assumption), same as the rest of the runtime.
const projectGitLocks = new Map<string, Promise<unknown>>();

export function withProjectGitLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
	const prev = projectGitLocks.get(projectId) ?? Promise.resolve();
	const run = prev.then(() => fn());
	const tail = run.catch(() => {});
	projectGitLocks.set(projectId, tail);
	void tail.then(() => {
		if (projectGitLocks.get(projectId) === tail) projectGitLocks.delete(projectId);
	});
	return run;
}
