import { logger } from '../../logger';
import { INSTANCE_LABEL } from './labels';
import type { ContainerEngine } from './types';

const log = logger.child('sandbox-reaper');

export { INSTANCE_LABEL } from './labels';

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
	/**
	 * Containers that looked orphaned this pass. Feed straight back in as
	 * `previouslySuspected` next tick - see {@link reapOrphanedContainers} for why
	 * a single sighting is not enough to destroy on.
	 */
	suspected: Set<string>;
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
 * `liveContainerIds` is every id Hezo still references - **both** representations
 * of a container, the project row *and* the pool member. A project owns several
 * containers at once while `projects.container_id` names only the most recently
 * provisioned or resumed one, so a live set built from projects alone reads a
 * busy run's container, a suspended member, and a member pinned for unpushed
 * commits as orphans and destroys all three. Passing the set in (rather than
 * querying here) keeps this pure enough to test against a fake engine and leaves
 * the ownership question with the caller, which is the only place that knows it.
 *
 * **A container is destroyed only on its second consecutive sighting.** There is
 * a window during provisioning where a container exists on the engine but is
 * recorded nowhere yet - `createContainer` has returned an id and the pool row is
 * not written until after it starts - and a container caught mid-provision looks
 * exactly like an orphan. No ordering of the two reads closes that window, and
 * neither engine exposes a creation time to age it out with. A second sighting
 * ten minutes later does: whatever was mid-provision has long since been
 * recorded, while a genuine orphan is still there. The cost is that an orphan
 * bills for one extra period, which is the right trade against destroying a
 * container that is running someone's work.
 *
 * `requireSecondSighting: false` lifts that on the **startup** pass only, where
 * the window it guards cannot be open: reconciliation has just failed every
 * stranded run and nothing is provisioning yet. Its caller is responsible for
 * establishing that this process is the data dir's sole owner - see
 * `JobManager.reconcileOnStartup`. Without it, a dev loop that restarts more
 * often than the sweep's cadence never reaps anything at all, because the
 * suspicion set lives in memory and starts empty on every boot.
 *
 * Best-effort throughout: an engine that cannot be reached returns no work
 * rather than throwing, and one failed destroy never aborts the sweep.
 */
export async function reapOrphanedContainers(
	engine: ContainerEngine,
	instanceId: string,
	liveContainerIds: ReadonlySet<string>,
	previouslySuspected: ReadonlySet<string> = new Set(),
	opts: { requireSecondSighting?: boolean } = {},
): Promise<ReapResult> {
	const requireSecondSighting = opts.requireSecondSighting ?? true;
	const result: ReapResult = { examined: 0, destroyed: [], deferred: 0, suspected: new Set() };

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
	for (const orphan of orphans) result.suspected.add(orphan.Id);

	// Only a container suspected on the previous pass as well is actually gone;
	// see the note above on the provisioning window, and on when it is safe to
	// skip the wait.
	const confirmed = requireSecondSighting
		? orphans.filter((c) => previouslySuspected.has(c.Id))
		: orphans;
	if (confirmed.length > MAX_PER_PASS) {
		result.deferred = confirmed.length - MAX_PER_PASS;
	}

	for (const orphan of confirmed.slice(0, MAX_PER_PASS)) {
		try {
			await engine.removeContainer(orphan.Id, true);
			result.destroyed.push(orphan.Id);
		} catch (e) {
			// Already gone, or mid-transition and not yet destroyable - either way
			// the next pass picks it up.
			log.warn(`Could not destroy orphaned container ${orphan.Id}: ${(e as Error).message}`);
		}
	}

	const awaitingSecondSighting = result.suspected.size - confirmed.length;
	if (result.destroyed.length > 0 || result.deferred > 0 || awaitingSecondSighting > 0) {
		// A silently-truncated sweep reads as "everything was cleaned up" when it
		// was not, so the deferred count is always stated - and so is the number
		// held back for confirmation, which is otherwise an invisible delay.
		log.info(
			`Reaped ${result.destroyed.length} orphaned container(s) of ${result.examined} owned` +
				(result.deferred > 0 ? `; ${result.deferred} deferred to the next pass` : '') +
				(awaitingSecondSighting > 0
					? `; ${awaitingSecondSighting} newly suspected, destroyed only if still orphaned next pass`
					: ''),
		);
	}
	return result;
}
