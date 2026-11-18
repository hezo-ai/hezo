import { sandboxBackendSharesProjectWorkspace } from '@hezo/shared';
import type { Db } from '../../db/database';
import type { RepoStore } from '../../lib/git-lock';
import { otherActiveRunsInProject } from '../run-concurrency';
import { getSandboxBackendSetting } from './backend-store';

/**
 * The store a container's clones live in, for `withRepoStoreLock`: the project
 * when the backend shares one workspace across a project's containers, the
 * container otherwise. Read through the backend's kind, never its name.
 */
export async function repoStoreFor(
	db: Db,
	projectId: string,
	containerId: string,
): Promise<RepoStore> {
	return {
		projectId,
		containerId,
		sharedAcrossContainers: sandboxBackendSharesProjectWorkspace(
			await getSandboxBackendSetting(db),
		),
	};
}

/**
 * The other active runs whose agents can be doing git work in this store's clones
 * right now, with the task each is on. The store lock covers only prep, so an
 * agent's own commits run alongside another run's prep.
 *
 * A shared store is the project's: every active run in the project may be working
 * in it. A store on one container's own disk serves one run at a time (the pool runs
 * one run per container), so it answers none without a query, and the cleanup this
 * gates - mandatory there, for the sandbox's small disk - never waits on activity
 * elsewhere in the project.
 */
export async function otherRunsSharingStore(
	db: Db,
	store: RepoStore,
	runId: string,
): Promise<Array<{ task_id: string | null }>> {
	if (!store.sharedAcrossContainers) return [];
	return otherActiveRunsInProject(db, store.projectId, runId);
}
