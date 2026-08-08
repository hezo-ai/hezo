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
	/**
	 * Free `needGb` by retiring idle members of *other* projects, then decide
	 * again. See {@link planCrossProjectReclaim}.
	 */
	| { kind: 'reclaim'; needGb: number }
	| { kind: 'queue' };

export interface PoolCapacity {
	/** Memory already promised to running containers instance-wide, in GB. */
	usedMemoryGb: number;
	/** Total memory all running containers may consume. Host memory locally; a spend guard remotely. */
	budgetGb: number;
	/** What one more container in *this* project would consume, in GB. */
	requestMemoryGb: number;
	/**
	 * Of {@link usedMemoryGb}, how much is held by idle members of **other**
	 * projects that reclaim could free right now, in GB.
	 *
	 * Separate from the used figure rather than subtracted from it because the
	 * memory is genuinely spoken for until something retires those containers -
	 * charging the budget as though it were already free would over-subscribe the
	 * host in the window between deciding and retiring.
	 */
	reclaimableMemoryGb: number;
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
 * 5. **Reclaim**, if the cap is full but idle containers in *other* projects hold
 *    enough memory to cover the request. A container is pinned to its project for
 *    its whole life - it is built around that project's workspace mount, clone and
 *    git identity - so the only way one project's idle capacity can serve another
 *    is to retire it and build afresh. Without this rung an instance can sit
 *    permanently wedged: a busy project's idle members are charged to the budget
 *    in full, and nothing else can touch them.
 * 6. **Queue**, when even that would not free enough.
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

	// The shortfall, not the request: reclaiming more than the request needs
	// destroys warm containers for nothing.
	const needGb = capacity.usedMemoryGb + capacity.requestMemoryGb - capacity.budgetGb;
	if (needGb <= capacity.reclaimableMemoryGb) return { kind: 'reclaim', needGb };
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
export interface IdleRetirementPlan {
	/** Stopped in place - the container survives, its writable layer intact. */
	suspend: PoolMember[];
	/** Removed outright; the filesystem is reproducible from the git remote. */
	destroy: PoolMember[];
}

export function planIdleShutdown(members: readonly PoolMember[]): IdleRetirementPlan {
	// Deliberately *not* filtered by `reservedForChat`. The reservation means "no
	// task run may take this container" - it does not mean "never stop it". By the
	// time this runs the project has already been judged idle by a predicate that
	// includes its chat session (a live or recently-active session makes the
	// project busy and it is never a candidate), so a chat container reaching here
	// is one whose session has gone quiet. Suspending it is correct: the session
	// parks, and resume starts it again with a fresh host-side half. Treating the
	// reservation as a pin here would keep the container running forever.
	const idle = members.filter((m) => m.state === 'idle');
	if (idle.length === 0) return { suspend: [], destroy: [] };

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
	// So **every** pinned member is suspended, not just one. The single-suspend
	// rule below is a storage-economy bound on containers kept purely for warmth,
	// and applying it to pinned members instead left the surplus ones running -
	// which is the exact budget leak the paragraph above rules out, reached by a
	// different route.
	const pinned = idle.filter((m) => m.hasUnpushedCommits);
	const disposable = idle.filter((m) => !m.hasUnpushedCommits);
	if (pinned.length > 0) return { suspend: pinned, destroy: disposable };

	const alreadySuspended = members.some((m) => m.state === 'suspended');
	if (alreadySuspended) return { suspend: [], destroy: disposable };
	const [first, ...rest] = disposable;
	return { suspend: first ? [first] : [], destroy: rest };
}

/**
 * Which of a **working** project's idle containers to retire, judged on each
 * member's own idle clock rather than on the project falling quiet.
 *
 * {@link planIdleShutdown} answers "this whole project has gone idle, retire its
 * pool". That is the only question the sweeper used to ask, and it left a gap
 * wide enough to wedge an instance: a project with two busy containers and two
 * idle ones is never quiet, so its idle members were never candidates, while
 * being charged to the instance memory budget in full for as long as the project
 * kept working. Every other project saw a budget it could not reach and queued
 * indefinitely.
 *
 * So a project that is *working* has its idle members judged individually. There
 * is no keep-one-warm rule here, unlike the whole-project plan: the busy members
 * are about to become idle themselves, so warmth for the next run is already
 * accounted for, and holding a second container against that is what the caller
 * is trying to stop.
 *
 * `staleMemberIds` are the members the caller has established sat idle past the
 * window - the clock lives in SQL, where it can be indexed, so this stays pure.
 * The chat's pinned member is never touched: it is excluded from the memory
 * budget already, so retiring it frees nothing and only interrupts a session.
 */
export function planSurplusIdleRetirement(
	members: readonly PoolMember[],
	staleMemberIds: ReadonlySet<string>,
): IdleRetirementPlan {
	// Not a working project - either fully idle, in which case the whole-project
	// pass owns it and its warm-start guarantees, or holding nothing at all.
	if (!members.some((m) => m.state === 'busy')) return { suspend: [], destroy: [] };

	const stale = members.filter(
		(m) => m.state === 'idle' && !m.reservedForChat && staleMemberIds.has(m.id),
	);
	return {
		suspend: stale.filter((m) => m.hasUnpushedCommits),
		destroy: stale.filter((m) => !m.hasUnpushedCommits),
	};
}

/** An idle container in some *other* project, offered up to cover a blocked run. */
export interface ReclaimCandidate {
	containerId: string;
	projectId: string;
	/** What retiring it gives back to the instance budget, in GB. */
	memoryGb: number;
	/** How long it has sat idle. The caller supplies the clock; this stays pure. */
	idleForMs: number;
	hasUnpushedCommits: boolean;
}

export interface ReclaimPlan {
	suspend: ReclaimCandidate[];
	destroy: ReclaimCandidate[];
	/** What executing this plan gives back, in GB. Zero for an empty plan. */
	freedGb: number;
}

/**
 * Which of other projects' idle containers to retire so a blocked run fits.
 *
 * Reached only from the `reclaim` rung of {@link selectPoolMember}, which is to
 * say only when a run would otherwise queue. Idle containers are *useful* while
 * nobody else wants the memory - that is the whole point of keeping them warm -
 * so nothing here runs speculatively.
 *
 * Four rules, each closing a way this could do harm:
 *
 * - **All or nothing.** If the eligible candidates together cannot cover
 *   `needGb`, the plan is empty. Freeing three of the four GB a run needs helps
 *   nobody and has destroyed two warm containers to achieve it.
 * - **Only as much as `needGb`.** Retiring past the shortfall is the same waste
 *   in smaller units.
 * - **The project holding the most idle containers loses first**, and only then
 *   longest-idle first. Ordering by idle time alone takes a quiet project's one
 *   warm container while a hoarder keeps three, which is the fairness question
 *   inverted; the tie-break on container id after that keeps the plan
 *   deterministic for a given input, so a test can pin it.
 * - **`minIdleMs` floors eligibility.** A project releasing a container between
 *   two runs seconds apart is mid-burst, not idle, and stripping it there makes
 *   both runs pay a cold start to hand memory to a third project that would lose
 *   it the same way. This is what stops two starved projects reclaiming from each
 *   other in a loop.
 *
 * Unpushed commits are suspended rather than destroyed, for the reason
 * {@link planIdleShutdown} sets out at length: suspend frees the memory and keeps
 * the only copy of the work.
 */
export function planCrossProjectReclaim(
	candidates: readonly ReclaimCandidate[],
	needGb: number,
	minIdleMs: number,
): ReclaimPlan {
	const empty: ReclaimPlan = { suspend: [], destroy: [], freedGb: 0 };
	if (needGb <= 0) return empty;

	const eligible = candidates.filter((c) => c.idleForMs >= minIdleMs);
	if (eligible.reduce((sum, c) => sum + c.memoryGb, 0) < needGb) return empty;

	const heldBy = new Map<string, number>();
	for (const c of eligible) heldBy.set(c.projectId, (heldBy.get(c.projectId) ?? 0) + 1);

	const ordered = [...eligible].sort((a, b) => {
		const byHoard = (heldBy.get(b.projectId) ?? 0) - (heldBy.get(a.projectId) ?? 0);
		if (byHoard !== 0) return byHoard;
		if (b.idleForMs !== a.idleForMs) return b.idleForMs - a.idleForMs;
		return a.containerId.localeCompare(b.containerId);
	});

	const plan: ReclaimPlan = { suspend: [], destroy: [], freedGb: 0 };
	for (const candidate of ordered) {
		if (plan.freedGb >= needGb) break;
		(candidate.hasUnpushedCommits ? plan.suspend : plan.destroy).push(candidate);
		plan.freedGb += candidate.memoryGb;
	}
	return plan;
}
