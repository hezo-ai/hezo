// Serializes git operations that mutate a repo's shared .git store (clone,
// fetch, worktree add, reset) per project. Concurrent runs on the same project
// work in separate per-task worktrees but share one .git per repo, so these
// brief setup/recovery steps must not overlap or they race on git's index/ref
// locks. Keyed by project id, so different projects never block one another.
// In-process only (single-server assumption), same as the rest of the runtime.
import { type KeyedLockRegistry, withKeyedLock } from './keyed-lock';

const projectGitLocks: KeyedLockRegistry = new Map();

export function withProjectGitLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
	return withKeyedLock(projectGitLocks, projectId, fn);
}
