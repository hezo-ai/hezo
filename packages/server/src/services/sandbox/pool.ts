/**
 * Which container a run gets.
 *
 * Kept pure - no DB, no engine, no clock - because the ladder below is the
 * whole of the pool's behaviour and it is far easier to be sure of when it can
 * be enumerated directly. The caller supplies the members and the capacity; it
 * returns a decision.
 *
 * The rule everything follows from: **a container serves at most one run at a
 * time.** Sharing one between concurrent runs is precisely the failure the pool
 * exists to remove - today they share a single memory cap, so
 * `enforceContainerMemoryLimit` stops the container and `failProjectRuns` fails
 * *every* run in the project. One greedy run takes down its siblings.
 */

/**
 * Disk a member may consume before it is recycled rather than reused.
 *
 * This is the constraint that does not exist on a local daemon, where
 * `/workspace` is a bind mount with the operator's whole disk behind it, and the
 * one that bites on a managed sandbox, which gets a few GB in total. Set below
 * the provider allocation rather than at it: a container that fills up *during*
 * a run fails that run partway through, which is strictly worse than paying for
 * a fresh container up front.
 */
export const POOL_DISK_CEILING_BYTES = 2 * 1024 ** 3;

export type PoolMemberState =
	/** Running and serving a run. */
	| 'busy'
	/** Running, serving nothing, still warm. */
	| 'idle'
	/** Stopped, filesystem intact, resumable in about a second. */
	| 'suspended';

export interface PoolMember {
	id: string;
	state: PoolMemberState;
	/** The task this container last served, for affinity. Null if it has served none. */
	lastTaskId: string | null;
	/**
	 * Whether this container holds commits that reached neither `origin` nor the
	 * mirror. Such a container must not be recycled - the work exists nowhere
	 * else, and nothing else would notice it had gone.
	 */
	hasUnpushedCommits: boolean;
	/** True when the container is at its disk ceiling and should be recycled rather than reused. */
	atDiskCeiling: boolean;
	/** The chat's pinned container, which a task run may never take. */
	reservedForChat: boolean;
}

export type PoolDecision =
	| { kind: 'reuse'; member: PoolMember }
	| { kind: 'resume'; member: PoolMember }
	| { kind: 'create' }
	| { kind: 'queue' };

export interface PoolCapacity {
	/** Memory already promised to running containers instance-wide, in GB. */
	usedMemoryGb: number;
	/** Total memory all running containers may consume. Host memory locally; a spend guard remotely. */
	budgetGb: number;
	/** What one more container in *this* project would consume, in GB. */
	requestMemoryGb: number;
}

/**
 * Pick a container for a run, or say to create or queue one.
 *
 * The ladder, first match wins:
 *
 * 1. **A warm idle container that last served this task.** Nothing to start,
 *    and the task's worktree and `node_modules` are already built. This is the
 *    common case rather than an optimization: the wakeup model gives a task
 *    many runs (replies, retries, timeouts, hire resolutions), and
 *    `prepareWorktrees` already reuses a task's worktree rather than deleting
 *    it.
 * 2. **Any warm idle container.** Nothing to start, cold worktree.
 * 3. **A suspended container.** Resume costs about a second.
 * 4. **Create**, if under the cap.
 * 5. **Queue** on the cap.
 *
 * Note what is *not* here: no rung ever returns a busy container. That is the
 * one-run-per-container rule, and it is what makes a sibling run unable to kill
 * this one.
 */
export function selectPoolMember(
	taskId: string | null,
	members: readonly PoolMember[],
	capacity: PoolCapacity,
): PoolDecision {
	const available = members.filter(usable);

	if (taskId !== null) {
		const affine = available.find((m) => m.state === 'idle' && m.lastTaskId === taskId);
		if (affine) return { kind: 'reuse', member: affine };
	}

	const warm = available.find((m) => m.state === 'idle');
	if (warm) return { kind: 'reuse', member: warm };

	const suspended = available.find((m) => m.state === 'suspended');
	// Resuming a suspended container does not consume budget until it is running,
	// so it is still gated - otherwise a fleet of suspended containers could be
	// resumed straight past the budget.
	if (suspended && fitsBudget(capacity)) return { kind: 'resume', member: suspended };

	if (fitsBudget(capacity)) return { kind: 'create' };
	return { kind: 'queue' };
}

/**
 * Whether a member may serve a *task* run.
 *
 * Three exclusions, each for its own reason:
 * - **busy**: one run per container, the rule the pool exists for.
 * - **reservedForChat**: a queued task run is invisible and harmless, while a
 *   queued chat turn is a person watching a spinner - so chat's container is
 *   never taken from it. Note this excludes it from being *handed to a run*, not
 *   from being stopped when the whole project goes idle (see
 *   {@link planIdleShutdown}).
 * - **atDiskCeiling**: a container out of disk fails its run partway through,
 *   which is worse than paying for a fresh one.
 */
function usable(member: PoolMember): boolean {
	return member.state !== 'busy' && !member.reservedForChat && !member.atDiskCeiling;
}

/**
 * Whether another container in this project fits in what the budget has left.
 *
 * A budget rather than a count because a count only bounds memory while every
 * container is the same size, and `projects.memory_limit_gib` exists so they are
 * not. The consequence to be aware of is that a large container waits for enough
 * budget rather than for any free slot, so smaller runs can overtake it - which
 * is a delay, not starvation, because a cap larger than the whole budget is
 * refused where it is set (`projectMemoryFitsBudget`) rather than queued forever.
 */
function fitsBudget(capacity: PoolCapacity): boolean {
	return capacity.usedMemoryGb + capacity.requestMemoryGb <= capacity.budgetGb;
}

/**
 * Which containers to shut down when one goes idle, and how.
 *
 * A stopped container is already a suspended one: it still exists, its writable
 * layer is still on disk, and starting it resumes in place. Retention is free
 * on the operator's disk and billed as snapshot storage on a managed backend -
 * a reason to change a number, not the design.
 *
 * **At most one suspended container per project**, which is exactly Docker's
 * cardinality today. That single rule removes a whole category of work: no
 * retention cap, no reap horizon, no snapshot-storage growth to monitor.
 *
 * The cost is that the second and later containers in a burst are always
 * created cold. That is a bundle fetch plus a `git fetch` rather than a full
 * clone, it is paid only by genuinely concurrent runs, and it buys back a bound
 * that would otherwise have to be designed, tuned and tested.
 */
export function planIdleShutdown(members: readonly PoolMember[]): {
	suspend: PoolMember | null;
	destroy: PoolMember[];
} {
	// Deliberately *not* filtered by `reservedForChat`. The reservation means "no
	// task run may take this container" - it does not mean "never stop it". By the
	// time this runs the project has already been judged idle by a predicate that
	// includes its chat session (a live or recently-active session makes the
	// project busy and it is never a candidate), so a chat container reaching here
	// is one whose session has gone quiet. Suspending it is correct: the session
	// parks, and resume starts it again with a fresh host-side half. Treating the
	// reservation as a pin here would keep the container running forever.
	const idle = members.filter((m) => m.state === 'idle');
	const alreadySuspended = members.some((m) => m.state === 'suspended');

	// A container holding work that reached neither origin nor the mirror is
	// pinned: destroying it loses the only copy, and nothing downstream would
	// report that it had.
	const disposable = idle.filter((m) => !m.hasUnpushedCommits);
	if (disposable.length === 0) return { suspend: null, destroy: [] };

	if (alreadySuspended) return { suspend: null, destroy: disposable };
	const [first, ...rest] = disposable;
	return { suspend: first, destroy: rest };
}
