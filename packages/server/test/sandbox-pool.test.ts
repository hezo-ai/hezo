import { describe, expect, it } from 'vitest';
import {
	type PoolCapacity,
	type PoolMember,
	planIdleShutdown,
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
const ROOM: PoolCapacity = { usedMemoryGb: 2, budgetGb: 10, requestMemoryGb: 2 };
const FULL: PoolCapacity = { usedMemoryGb: 10, budgetGb: 10, requestMemoryGb: 2 };

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
		expect(plan.suspend?.id).toBe('a');
		expect(plan.destroy.map((m) => m.id)).toEqual(['b', 'c']);
	});

	it('destroys all of them when one is already suspended', () => {
		const plan = planIdleShutdown([member('kept', { state: 'suspended' }), member('a')]);
		expect(plan.suspend).toBeNull();
		expect(plan.destroy.map((m) => m.id)).toEqual(['a']);
	});

	it('never destroys a container holding unpushed commits', () => {
		// Destroying it loses the only copy, and nothing downstream would report
		// that it had. Suspending does not: the writable layer survives, which is
		// the whole premise of suspend-versus-destroy - so the pinned member is
		// the one that takes the suspend slot rather than being left running.
		const plan = planIdleShutdown([member('risky', { hasUnpushedCommits: true })]);
		expect(plan.destroy).toEqual([]);
		expect(plan.suspend?.id).toBe('risky');
	});

	it('prefers the risky container for the suspend slot and destroys the safe one', () => {
		// Leaving the pinned member running would hold its full RAM cap out of the
		// global budget forever - the flag is only cleared by a later run on that
		// same container, which for a stuck project never comes.
		const plan = planIdleShutdown([member('risky', { hasUnpushedCommits: true }), member('safe')]);
		expect(plan.suspend?.id).toBe('risky');
		expect(plan.destroy.map((m) => m.id)).toEqual(['safe']);
	});

	it('never destroys the pinned member even when something is already suspended', () => {
		const plan = planIdleShutdown([
			member('parked', { state: 'suspended' }),
			member('risky', { hasUnpushedCommits: true }),
			member('safe'),
		]);
		expect(plan.suspend).toBeNull();
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
		expect(plan.suspend?.id).toBe('chat');
		expect(plan.destroy).toEqual([]);
	});

	it('leaves busy containers alone', () => {
		const plan = planIdleShutdown([member('busy', { state: 'busy' })]);
		expect(plan.suspend).toBeNull();
		expect(plan.destroy).toEqual([]);
	});
});
