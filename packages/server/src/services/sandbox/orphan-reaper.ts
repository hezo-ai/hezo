import { logger } from '../../logger';
import type { ContainerEngine } from './types';

const log = logger.child('sandbox-reaper');

/**
 * The label every container Hezo creates carries, naming the instance that made
 * it. On local Docker this is belt-and-braces; on a managed backend it is the
 * thing that makes reaping safe at all, because several Hezo instances can
 * share one provider account and a sweep keyed on anything less specific would
 * destroy another instance's live sandboxes.
 */
export const INSTANCE_LABEL = 'hezo.instance';

/**
 * Ceiling on how many orphans one pass destroys. Every recurring job is bounded
 * - a runaway list must not turn one tick into thousands of API calls - and the
 * remainder is simply picked up next pass.
 */
const MAX_PER_PASS = 25;

export interface ReapResult {
	/** Containers examined that belong to this instance. */
	examined: number;
	destroyed: string[];
	/** Orphans left for the next pass because the per-pass bound was hit. */
	deferred: number;
}

/**
 * Destroy containers this instance created that no project still references.
 *
 * This exists because a managed backend bills for what it runs. Boot already
 * fails every in-flight run and never reattaches, so a crash, a hard kill or a
 * lost provider response leaves sandboxes with no owner - and unlike a stray
 * local Docker container, which costs disk, a stray sandbox costs money for as
 * long as nobody notices. It fails as a bill, not as an error, which is exactly
 * the kind of thing that needs a sweep rather than an alert.
 *
 * `liveContainerIds` is the set of ids projects currently point at; anything
 * labelled as ours and absent from it is an orphan. Passing the live set in
 * (rather than querying here) keeps this pure enough to test against a fake
 * engine and leaves the ownership question with the caller, which is the only
 * place that knows it.
 *
 * Best-effort throughout: an engine that cannot be reached returns no work
 * rather than throwing, and one failed destroy never aborts the sweep.
 */
export async function reapOrphanedContainers(
	engine: ContainerEngine,
	instanceId: string,
	liveContainerIds: ReadonlySet<string>,
): Promise<ReapResult> {
	const result: ReapResult = { examined: 0, destroyed: [], deferred: 0 };

	let owned: Array<{ Id: string; Names: string[] }>;
	try {
		owned = await engine.listContainersByLabel(`${INSTANCE_LABEL}=${instanceId}`);
	} catch (e) {
		// A provider blip must not turn a background sweep into a failed tick.
		log.warn(`Could not list containers for reaping: ${(e as Error).message}`);
		return result;
	}
	result.examined = owned.length;

	const orphans = owned.filter((c) => !liveContainerIds.has(c.Id));
	if (orphans.length > MAX_PER_PASS) {
		result.deferred = orphans.length - MAX_PER_PASS;
	}

	for (const orphan of orphans.slice(0, MAX_PER_PASS)) {
		try {
			await engine.removeContainer(orphan.Id, true);
			result.destroyed.push(orphan.Id);
		} catch (e) {
			// Already gone, or mid-transition and not yet destroyable - either way
			// the next pass picks it up.
			log.warn(`Could not destroy orphaned container ${orphan.Id}: ${(e as Error).message}`);
		}
	}

	if (result.destroyed.length > 0 || result.deferred > 0) {
		// A silently-truncated sweep reads as "everything was cleaned up" when it
		// was not, so the deferred count is always stated.
		log.info(
			`Reaped ${result.destroyed.length} orphaned container(s) of ${result.examined} owned` +
				(result.deferred > 0 ? `; ${result.deferred} deferred to the next pass` : ''),
		);
	}
	return result;
}
