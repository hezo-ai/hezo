import { sandboxBackendSharesProjectWorkspace } from '@hezo/shared';
import type { Db } from '../../db/database';
import type { RepoStore } from '../../lib/git-lock';
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
