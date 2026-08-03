import type { ContainerEngine } from './docker';
import { TEAM_LABEL } from './sandbox/labels';

/**
 * Best-effort removal of every container Hezo provisioned (any labelled
 * `hezo.team`, running or stopped). Called by `hezo uninstall` before the data
 * directory is deleted: those containers' ids live in the database we are about
 * to remove, so without this they would be orphaned — left running or stopped
 * with bind mounts into a directory that no longer exists.
 *
 * Returns the number of containers removed, or `null` when the Docker daemon is
 * not reachable (the user may have already quit Docker Desktop) so the caller
 * can tell "nothing to remove" apart from "could not check". Each container is
 * stopped then force-removed independently; a failure on one (already stopped,
 * already gone) never aborts the sweep.
 */
export async function removeProvisionedContainers(docker: ContainerEngine): Promise<number | null> {
	if (!(await docker.ping())) return null;

	const containers = await docker.listContainersByLabel(TEAM_LABEL);
	let removed = 0;
	for (const container of containers) {
		try {
			await docker.stopContainer(container.Id);
		} catch {
			// Already stopped, or stop raced removal — force-remove handles it.
		}
		try {
			await docker.removeContainer(container.Id, true);
			removed++;
		} catch {
			// Already removed externally, or removal in progress — skip.
		}
	}
	return removed;
}
