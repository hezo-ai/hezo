import { describe, expect, it } from 'vitest';
import {
	type PoolCapacity,
	type PoolMember,
	planCrossProjectReclaim,
	planIdleShutdown,
	planSurplusIdleRetirement,
	type ReclaimCandidate,
	selectPoolMember,
} from '../src/services/sandbox/pool';

// The cap every member in these tests was provisioned to cover. Stated once so a
// test that means to exercise the ladder is not accidentally exercising the
// allocation check in front of it.
const CAP = 2 * 1024 ** 3;

function member(id: string, over: Partial<PoolMember> = {}): PoolMember {
	return {
		id,
		state: 'idle',
		lastTaskId: null,
		hasUnpushedCommits: false,
		atDiskCeiling: false,
		memoryBytes: CAP,
		reservedForChat: false,
		...over,
	};
}

// Capacity is a memory budget, so "room" and "full" are stated in GB. A default
// container asks for 2 GB: ROOM has 8 GB of a 10 GB budget free, FULL has none.
// Both state nothing reclaimable, so the rungs under test are the ones exercised;
// FULL_RECLAIMABLE is the same wall with another project's idle container behind it.
const ROOM: PoolCapacity = {
	usedMemoryGb: 2,
	budgetGb: 10,
	requestMemoryGb: 2,
	reclaimableMemoryGb: 0,
};
const FULL: PoolCapacity = {
	usedMemoryGb: 10,
	budgetGb: 10,
	requestMemoryGb: 2,
	reclaimableMemoryGb: 0,
};
const FULL_RECLAIMABLE: PoolCapacity = { ...FULL, reclaimableMemoryGb: 2 };

describe('selectPoolMember ladder', () => {
	it('prefers a warm container that last served this task', () => {
		// The common case rather than an optimization: the wakeup model gives a
		// task many runs, and its worktree and node_modules are already built.
		const decision = selectPoolMember(
			'task-1',
			[member('other'), member('affine', { lastTaskId: 'task-1' })],
			ROOM,
			CAP,
		);
		expect(decision).toEqual({ kind: 'reuse', member: expect.objectContaining({ id: 'affine' }) });
	});

	it('falls back to any warm container', () => {
		const decision = selectPoolMember('task-1', [member('warm')], ROOM, CAP);
		expect(decision.kind).toBe('reuse');
	});

	it('resumes a suspended container when none is warm', () => {
		const decision = selectPoolMember(
			'task-1',
			[member('cold', { state: 'suspended' })],
			ROOM,
			CAP,
		);
		expect(decision).toEqual({ kind: 'resume', member: expect.objectContaining({ id: 'cold' }) });
	});

	it('creates when the pool is empty', () => {
		expect(selectPoolMember('task-1', [], ROOM, CAP)).toEqual({ kind: 'create' });
	});

	it('queues when the cap is reached', () => {
		expect(selectPoolMember('task-1', [], FULL, CAP)).toEqual({ kind: 'queue' });
	});

	it('queues rather than resuming past the cap', () => {
		// Resuming does not exempt a container from the cap - otherwise a fleet of
		// suspended containers could be woken straight through it.
		const decision = selectPoolMember('t', [member('cold', { state: 'suspended' })], FULL, CAP);
		expect(decision).toEqual({ kind: 'queue' });
	});

	it('reuses a warm container even at the cap, since it is already counted', () => {
		expect(selectPoolMember('t', [member('warm')], FULL, CAP).kind).toBe('reuse');
	});

	it('works with no task, where there is nothing to be affine to', () => {
		expect(selectPoolMember(null, [member('warm', { lastTaskId: 'other' })], ROOM, CAP).kind).toBe(
			'reuse',
		);
	});

	it('reclaims from other projects rather than queueing when the budget is full', () => {
		// A container belongs to its project for life, so the only way another
		// project's unused memory can serve this one is for that container to go.
		// Without this rung one busy project's idle containers wedge the instance:
		// they are charged to the budget in full and nothing can reach them.
		expect(selectPoolMember('t', [], FULL_RECLAIMABLE, CAP)).toEqual({
			kind: 'reclaim',
			needGb: 2,
		});
	});

	it('asks only for the shortfall, not for the whole request', () => {
		const capacity: PoolCapacity = {
			usedMemoryGb: 9,
			budgetGb: 10,
			requestMemoryGb: 2,
			reclaimableMemoryGb: 4,
		};
		expect(selectPoolMember('t', [], capacity, CAP)).toEqual({ kind: 'reclaim', needGb: 1 });
	});

	it('queues when reclaim could not free enough either', () => {
		const capacity: PoolCapacity = { ...FULL, requestMemoryGb: 8, reclaimableMemoryGb: 2 };
		expect(selectPoolMember('t', [], capacity, CAP)).toEqual({ kind: 'queue' });
	});

	it('creates rather than reclaiming while the budget still has room', () => {
		// Idle containers elsewhere are useful while nobody needs the memory; this
		// rung never runs speculatively.
		expect(selectPoolMember('t', [], { ...ROOM, reclaimableMemoryGb: 8 }, CAP)).toEqual({
			kind: 'create',
		});
	});

	it('reuses its own warm container rather than reclaiming another project’s', () => {
		expect(selectPoolMember('t', [member('warm')], FULL_RECLAIMABLE, CAP).kind).toBe('reuse');
	});
});

/**
 * What the ladder must never do. Each of these is a specific failure the pool
 * was built to remove, so they are asserted as exclusions rather than left to
 * follow from the ordering.
 */
describe('selectPoolMember exclusions', () => {
	it('never hands over a busy container', () => {
		// One run per container is the whole point: sharing one means sharing a
		// memory cap, and one greedy run stopping the container fails every run in
		// the project.
		const decision = selectPoolMember(
			'task-1',
			[member('busy', { state: 'busy', lastTaskId: 'task-1' })],
			ROOM,
			CAP,
		);
		expect(decision).toEqual({ kind: 'create' });
	});

	it('never hands the chat’s container to a task run', () => {
		// A queued task run is invisible and harmless; a queued chat turn is a
		// person watching a spinner.
		const decision = selectPoolMember('t', [member('chat', { reservedForChat: true })], ROOM, CAP);
		expect(decision).toEqual({ kind: 'create' });
	});

	it('never reuses a container that is out of disk', () => {
		// It would fail its run partway through, which is worse than paying for a
		// fresh one.
		const decision = selectPoolMember('t', [member('full', { atDiskCeiling: true })], ROOM, CAP);
		expect(decision).toEqual({ kind: 'create' });
	});

	it('queues rather than taking an excluded container when the cap is reached', () => {
		const decision = selectPoolMember(
			't',
			[member('busy', { state: 'busy' }), member('chat', { reservedForChat: true })],
			FULL,
			CAP,
		);
		expect(decision).toEqual({ kind: 'queue' });
	});

	it('never reuses a container built for a different memory cap', () => {
		// The cap is a guarantee the run is sized and budgeted against, and no
		// backend can resize a container in place - so one built for less would OOM
		// the run it was handed.
		const stale = member('stale', { memoryBytes: CAP / 2 });
		expect(selectPoolMember('t', [stale], ROOM, CAP)).toEqual({
			kind: 'recycle',
			members: [stale],
		});
	});

	it('recycles a container built for more than the cap too', () => {
		// It covers the cap, but a managed backend keeps billing for memory the
		// operator has given back.
		const large = member('large', { memoryBytes: CAP * 4 });
		expect(selectPoolMember('t', [large], ROOM, CAP)).toEqual({
			kind: 'recycle',
			members: [large],
		});
	});

	it('recycles a container whose allocation was never recorded', () => {
		// Unknown is not a match: an adopted container, or one predating the column,
		// cannot be shown to cover the cap and guessing that it does is how a
		// container ends up serving a run it is too small for.
		const adopted = member('adopted', { memoryBytes: null });
		expect(selectPoolMember('t', [adopted], ROOM, CAP)).toEqual({
			kind: 'recycle',
			members: [adopted],
		});
	});

	it('recycles before every reuse rung, including an affine warm container', () => {
		const affine = member('affine', { lastTaskId: 'task-1', memoryBytes: CAP / 2 });
		expect(selectPoolMember('task-1', [affine], ROOM, CAP)).toEqual({
			kind: 'recycle',
			members: [affine],
		});
	});

	it('returns every mismatched member at once, not one per decision', () => {
		// The caller clears them in a single pass; one per re-decide would outlast a
		// pool larger than its retry budget.
		const decision = selectPoolMember(
			't',
			[member('a', { memoryBytes: null }), member('b', { memoryBytes: CAP * 2 }), member('ok')],
			ROOM,
			CAP,
		);
		expect(decision).toEqual({
			kind: 'recycle',
			members: [expect.objectContaining({ id: 'a' }), expect.objectContaining({ id: 'b' })],
		});
	});

	it('never recycles a busy container out from under its run', () => {
		// It is replaced the next time it comes up for acquisition, which is the
		// first moment that costs no run.
		const decision = selectPoolMember(
			't',
			[member('busy', { state: 'busy', memoryBytes: CAP / 2 })],
			ROOM,
			CAP,
		);
		expect(decision).toEqual({ kind: 'create' });
	});

	it('recycles a mismatched member even when the budget is full', () => {
		// Destroying it is what frees the budget the replacement needs; refusing
		// here would queue every run in the project behind a container nothing can
		// ever use.
		const stale = member('stale', { memoryBytes: CAP / 2 });
		expect(selectPoolMember('t', [stale], FULL, CAP)).toEqual({
			kind: 'recycle',
			members: [stale],
		});
	});

	it('prefers a usable container over an affine one that is busy', () => {
		const decision = selectPoolMember(
			'task-1',
			[member('affine-busy', { state: 'busy', lastTaskId: 'task-1' }), member('free')],
			ROOM,
			CAP,
		);
		expect(decision).toEqual({ kind: 'reuse', member: expect.objectContaining({ id: 'free' }) });
	});
});

describe('planIdleShutdown', () => {
	it('suspends the first idle container and destroys the rest', () => {
		// At most one suspended container per project - exactly Docker's
		// cardinality - which removes the need for a retention cap or a reap
		// horizon entirely.
		const plan = planIdleShutdown([member('a'), member('b'), member('c')]);
		expect(plan.suspend.map((m) => m.id)).toEqual(['a']);
		expect(plan.destroy.map((m) => m.id)).toEqual(['b', 'c']);
	});

	it('destroys all of them when one is already suspended', () => {
		const plan = planIdleShutdown([member('kept', { state: 'suspended' }), member('a')]);
		expect(plan.suspend).toEqual([]);
		expect(plan.destroy.map((m) => m.id)).toEqual(['a']);
	});

	it('never destroys a container holding unpushed commits', () => {
		// Destroying it loses the only copy, and nothing downstream would report
		// that it had. Suspending does not: the writable layer survives, which is
		// the whole premise of suspend-versus-destroy - so the pinned member is
		// the one that takes the suspend slot rather than being left running.
		const plan = planIdleShutdown([member('risky', { hasUnpushedCommits: true })]);
		expect(plan.destroy).toEqual([]);
		expect(plan.suspend.map((m) => m.id)).toEqual(['risky']);
	});

	it('prefers the risky container for the suspend slot and destroys the safe one', () => {
		// Leaving the pinned member running would hold its full RAM cap out of the
		// global budget forever - the flag is only cleared by a later run on that
		// same container, which for a stuck project never comes.
		const plan = planIdleShutdown([member('risky', { hasUnpushedCommits: true }), member('safe')]);
		expect(plan.suspend.map((m) => m.id)).toEqual(['risky']);
		expect(plan.destroy.map((m) => m.id)).toEqual(['safe']);
	});

	it('suspends every pinned member, even when one is already suspended', () => {
		// The single-suspend rule bounds containers kept purely for *warmth*.
		// Applying it to a pinned member instead left that member running - holding
		// its full RAM cap out of the budget forever, since nothing but a later run
		// on that same container clears the flag. That is the leak the rule was
		// written to prevent, reached from the other side.
		const plan = planIdleShutdown([
			member('parked', { state: 'suspended' }),
			member('risky', { hasUnpushedCommits: true }),
			member('safe'),
		]);
		expect(plan.suspend.map((m) => m.id)).toEqual(['risky']);
		expect(plan.destroy.map((m) => m.id)).toEqual(['safe']);
	});

	it('suspends the chat’s container once the project itself is idle', () => {
		// The reservation keeps a *task run* off this container; it is not a pin
		// against stopping. Reaching here means the project-level predicate already
		// judged the project idle, and that predicate treats a live or recently
		// active chat session as busy - so a reserved container that gets this far
		// belongs to a session that has gone quiet. Parking it is the point:
		// otherwise the chat's container runs, and bills, forever.
		const plan = planIdleShutdown([member('chat', { reservedForChat: true })]);
		expect(plan.suspend.map((m) => m.id)).toEqual(['chat']);
		expect(plan.destroy).toEqual([]);
	});

	it('leaves busy containers alone', () => {
		const plan = planIdleShutdown([member('busy', { state: 'busy' })]);
		expect(plan.suspend).toEqual([]);
		expect(plan.destroy).toEqual([]);
	});
});

/**
 * The reported failure in one function: a project running two tasks alongside two
 * idle containers is never "quiet", so nothing retired those two - while they were
 * charged to the instance memory budget in full and no other project could reach
 * that memory.
 */
describe('planSurplusIdleRetirement', () => {
	const stale = (...ids: string[]) => new Set(ids);

	it('retires a working project’s stale idle containers', () => {
		const plan = planSurplusIdleRetirement(
			[
				member('busy-1', { state: 'busy' }),
				member('busy-2', { state: 'busy' }),
				member('idle-1'),
				member('idle-2'),
			],
			stale('idle-1', 'idle-2'),
		);
		expect(plan.destroy.map((m) => m.id)).toEqual(['idle-1', 'idle-2']);
		expect(plan.suspend).toEqual([]);
	});

	it('leaves a fully idle project to the whole-project pass', () => {
		// That pass keeps one member suspended for a warm restart; picking its
		// members off individually here would take that away.
		const plan = planSurplusIdleRetirement([member('a'), member('b')], stale('a', 'b'));
		expect(plan).toEqual({ suspend: [], destroy: [] });
	});

	it('leaves an idle container that has not yet gone stale', () => {
		const plan = planSurplusIdleRetirement(
			[member('busy', { state: 'busy' }), member('fresh'), member('old')],
			stale('old'),
		);
		expect(plan.destroy.map((m) => m.id)).toEqual(['old']);
	});

	it('suspends rather than destroys a container holding unpushed commits', () => {
		const plan = planSurplusIdleRetirement(
			[member('busy', { state: 'busy' }), member('risky', { hasUnpushedCommits: true })],
			stale('risky'),
		);
		expect(plan.suspend.map((m) => m.id)).toEqual(['risky']);
		expect(plan.destroy).toEqual([]);
	});

	it('never touches the chat’s container or a busy one', () => {
		// The chat's member is excluded from the memory budget already, so retiring
		// it frees nothing and only interrupts a session.
		const plan = planSurplusIdleRetirement(
			[
				member('busy', { state: 'busy' }),
				member('chat', { reservedForChat: true }),
				member('other-busy', { state: 'busy' }),
			],
			stale('chat', 'other-busy'),
		);
		expect(plan).toEqual({ suspend: [], destroy: [] });
	});
});

describe('planCrossProjectReclaim', () => {
	const MIN_IDLE = 30_000;
	const candidate = (
		containerId: string,
		projectId: string,
		over: Partial<ReclaimCandidate> = {},
	): ReclaimCandidate => ({
		containerId,
		projectId,
		memoryGb: 2,
		idleForMs: 5 * 60_000,
		hasUnpushedCommits: false,
		...over,
	});

	it('frees exactly what the shortfall needs and no more', () => {
		// Retiring past the shortfall destroys warm containers for nothing.
		const plan = planCrossProjectReclaim(
			[candidate('a', 'p1'), candidate('b', 'p1'), candidate('c', 'p1')],
			2,
			MIN_IDLE,
		);
		expect(plan.destroy).toHaveLength(1);
		expect(plan.freedGb).toBe(2);
	});

	it('returns an empty plan when it cannot cover the shortfall', () => {
		// All or nothing: freeing 2 of the 6 GB a run needs helps nobody, and has
		// destroyed a warm container to achieve it.
		const plan = planCrossProjectReclaim([candidate('a', 'p1')], 6, MIN_IDLE);
		expect(plan).toEqual({ suspend: [], destroy: [], freedGb: 0 });
	});

	it('takes from the project holding the most idle containers first', () => {
		// Ordering by idle time alone takes a quiet project's single warm container
		// while a hoarder keeps three, which is the fairness question inverted.
		const plan = planCrossProjectReclaim(
			[
				candidate('lonely', 'quiet', { idleForMs: 60 * 60_000 }),
				candidate('h1', 'hoarder'),
				candidate('h2', 'hoarder'),
				candidate('h3', 'hoarder'),
			],
			2,
			MIN_IDLE,
		);
		expect(plan.destroy.map((c) => c.projectId)).toEqual(['hoarder']);
	});

	it('takes the longest-idle container within one project', () => {
		const plan = planCrossProjectReclaim(
			[
				candidate('recent', 'p1', { idleForMs: 60_000 }),
				candidate('ancient', 'p1', { idleForMs: 60 * 60_000 }),
			],
			2,
			MIN_IDLE,
		);
		expect(plan.destroy.map((c) => c.containerId)).toEqual(['ancient']);
	});

	it('ignores a container that has only just gone idle', () => {
		// A project releasing a container between two runs seconds apart is
		// mid-burst, not idle. This floor is what stops two starved projects
		// reclaiming from each other in a loop.
		const plan = planCrossProjectReclaim(
			[candidate('justreleased', 'p1', { idleForMs: 1_000 })],
			2,
			MIN_IDLE,
		);
		expect(plan).toEqual({ suspend: [], destroy: [], freedGb: 0 });
	});

	it('suspends a container holding unpushed commits rather than destroying it', () => {
		// Suspend frees the memory and keeps the only copy of the work.
		const plan = planCrossProjectReclaim(
			[candidate('risky', 'p1', { hasUnpushedCommits: true })],
			2,
			MIN_IDLE,
		);
		expect(plan.suspend.map((c) => c.containerId)).toEqual(['risky']);
		expect(plan.destroy).toEqual([]);
		expect(plan.freedGb).toBe(2);
	});

	it('accounts for containers of different sizes', () => {
		// The budget is memory, not a container count, because
		// `projects.memory_limit_gib` exists so containers are not all the same size.
		const plan = planCrossProjectReclaim(
			[candidate('big', 'p1', { memoryGb: 8 }), candidate('small', 'p2', { memoryGb: 1 })],
			4,
			MIN_IDLE,
		);
		expect(plan.destroy.map((c) => c.containerId)).toEqual(['big']);
		expect(plan.freedGb).toBe(8);
	});

	it('asks for nothing when the shortfall is zero or negative', () => {
		expect(planCrossProjectReclaim([candidate('a', 'p1')], 0, MIN_IDLE).freedGb).toBe(0);
	});
});
