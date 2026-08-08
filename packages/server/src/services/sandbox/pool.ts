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

// The disk a member may consume before it is recycled rather than reused is
// `poolDiskCeilingBytes(allocation)` in `@hezo/shared`, and it is recorded per
// member (`container_pool_members.disk_ceiling_bytes`) rather than shared. The
// allocation is a setting with a per-project override, so a single constant here
// would either be far above what a small container can hold or would recycle a
// large one with most of its disk free. The constraint itself does not exist on a
// local daemon, where the workspace is a bind mount with the operator's whole
// disk behind it; it is what bites on a managed sandbox.

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
	/**
	 * The memory cap this container was provisioned to cover, in bytes. Null for a
	 * container whose allocation is unrecorded - one adopted from outside the pool,
	 * or created before the column existed - which is indistinguishable from one
	 * built to the wrong size and treated the same way.
	 */
	memoryBytes: number | null;
	/** The chat's pinned container, which a task run may never take. */
	reservedForChat: boolean;
}

export type PoolDecision =
	| { kind: 'reuse'; member: PoolMember }
	| { kind: 'resume'; member: PoolMember }
	/** Destroy these, then decide again. See {@link selectPoolMember}. */
	| { kind: 'recycle'; members: PoolMember[] }
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
 * Pick a container for a run, or say to create, recycle or queue one.
 *
 * Ahead of the ladder: **any member not provisioned to the cap it would be
 * provisioned to now is recycled**, not reused. The cap is a memory guarantee
 * the run is sized and budgeted against, and no backend can resize a container
 * in place, so a container built to a different figure cannot be made to satisfy
 * the current one. Both directions matter - a smaller container fails the run it
 * was handed partway through, and a larger one keeps a managed account paying
 * for memory the operator has since given back. An unrecorded allocation cannot
 * be shown to match and is recycled on the same reasoning.
 *
 * All of them come back at once so the caller clears them in a single pass
 * rather than one per re-decide, which a pool larger than the caller's retry
 * budget would otherwise outlast.
 *
 * Then the ladder, first match wins:
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
 * Note what is *not* here: no rung ever returns a busy container, and no busy
 * container is ever recycled. That is the one-run-per-container rule, and it is
 * what makes a sibling run unable to kill this one - a busy member holding the
 * wrong allocation is caught the next time it comes up for acquisition, which is
 * the first moment it can be replaced without killing a run mid-flight.
 *
 * `requiredMemoryBytes` is separate from `capacity.requestMemoryGb` because they
 * answer different questions. The capacity figure is what a *new* container
 * costs the budget, and the chat workload deliberately states zero there to
 * exempt itself; this is what every container must have been built to, which is
 * the project's cap for every workload alike.
 */
export function selectPoolMember(
	taskId: string | null,
	members: readonly PoolMember[],
	capacity: PoolCapacity,
	requiredMemoryBytes: number,
): PoolDecision {
	const mismatched = members.filter(
		(m) => m.state !== 'busy' && m.memoryBytes !== requiredMemoryBytes,
	);
	if (mismatched.length > 0) return { kind: 'recycle', members: mismatched };

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

	// A container holding work that reached no durable remote is pinned against
	// **destroy** - that is what would lose the only copy, and nothing downstream
	// would report that it had.
	//
	// It is deliberately *not* pinned against suspend. Suspending preserves the
	// writable layer (that is the entire premise of suspend-versus-destroy here),
	// so the commits survive it untouched, while leaving the container running
	// holds its full RAM cap out of the global budget indefinitely - the flag is
	// only ever cleared by a later run on that same container, which for a stuck
	// project never comes. A handful of such projects would consume the whole
	// budget and queue every run on the instance forever.
	//
	// So a pinned member is the *preferred* suspend candidate: it is the one that
	// must not be destroyed, and suspending is how it stops costing memory while
	// still holding the work.
	const pinned = idle.filter((m) => m.hasUnpushedCommits);
	const disposable = idle.filter((m) => !m.hasUnpushedCommits);
	if (idle.length === 0) return { suspend: null, destroy: [] };

	if (alreadySuspended) return { suspend: null, destroy: disposable };
	// Prefer a pinned member for the single suspend slot; the rest that may be
	// destroyed are only ever the unpinned ones.
	if (pinned.length > 0) return { suspend: pinned[0], destroy: disposable };
	const [first, ...rest] = disposable;
	return { suspend: first ?? null, destroy: rest };
}
