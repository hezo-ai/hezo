// Serializes git operations that mutate a repo's .git store (clone, fetch,
// worktree add, reset). Concurrent runs work in separate per-task worktrees but
// share one .git per repo wherever they share a clone, so these steps must not
// overlap there or they race on git's index/ref locks.
//
// Keyed on the clone's store, not the project: on a backend that bind-mounts one
// workspace into every container of a project the store is the project; on one
// where each container has its own disk it is the container, and a lock per
// project would only make fresh containers clone one after another for nothing.
// In-process only (single-server assumption), same as the rest of the runtime.
import { type KeyedLockRegistry, withKeyedLock } from './keyed-lock';

const repoStoreLocks: KeyedLockRegistry = new Map();

/** Where a set of clones lives: the unit git work on them serializes over. */
export interface RepoStore {
	projectId: string;
	containerId: string;
	/** The project's containers share one workspace, so one store per project. */
	sharedAcrossContainers: boolean;
}

export function repoStoreKey(store: RepoStore): string {
	return store.sharedAcrossContainers
		? `project:${store.projectId}`
		: `container:${store.containerId}`;
}

export function withRepoStoreLock<T>(store: RepoStore, fn: () => Promise<T>): Promise<T> {
	return withKeyedLock(repoStoreLocks, repoStoreKey(store), fn);
}
