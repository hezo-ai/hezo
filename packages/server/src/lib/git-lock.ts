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
import { acquireKeyedLock, type KeyedLockRegistry, withKeyedLock } from './keyed-lock';

const repoStoreLocks: KeyedLockRegistry = new Map();

// Held by a re-clone from just before its active-run check until its clone has
// finished, and taken for no time at all by a task run before its agent starts.
// The check sees the runs already active; this is what stops a run that starts
// after it from working in a worktree the re-clone is about to delete. A family of
// its own rather than the store lock: a run start waiting on the store lock would
// also queue behind every other run's repo prep, which can take minutes. Held
// across the wipe and the clone on purpose, since that is the span a new run must
// not work in; only a re-clone, an admin action, holds it for longer than an
// acquire.
const repoStoreReclones: KeyedLockRegistry = new Map();

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

/**
 * Run `fn` as a re-clone of `store`. A task run that starts meanwhile waits in
 * {@link waitForRepoStoreReclone} until `fn` settles.
 */
export function withRepoStoreReclone<T>(store: RepoStore, fn: () => Promise<T>): Promise<T> {
	return withKeyedLock(repoStoreReclones, repoStoreKey(store), fn);
}

/**
 * Wait out a re-clone of `store`, if one is under way; `onWait` is told when
 * there is one. Returns at once when there is none, and early when `signal`
 * fires: the caller checks the signal itself.
 */
export async function waitForRepoStoreReclone(
	store: RepoStore,
	signal: AbortSignal,
	onWait: () => void,
): Promise<void> {
	const key = repoStoreKey(store);
	if (!repoStoreReclones.has(key)) return;
	onWait();
	try {
		const release = await acquireKeyedLock(repoStoreReclones, key, { signal });
		release();
	} catch (e) {
		if (!signal.aborted) throw e;
	}
}
