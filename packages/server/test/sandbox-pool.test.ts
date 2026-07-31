import { describe, expect, it } from 'vitest';
import {
	type PoolCapacity,
	type PoolMember,
	planIdleShutdown,
	selectPoolMember,
} from '../src/services/sandbox/pool';

function member(id: string, over: Partial<PoolMember> = {}): PoolMember {
	return {
		id,
		state: 'idle',
		lastTaskId: null,
		hasUnpushedCommits: false,
		atDiskCeiling: false,
		reservedForChat: false,
		...over,
	};
}

const ROOM: PoolCapacity = { runningContainers: 1, maxRunningContainers: 5 };
const FULL: PoolCapacity = { runningContainers: 5, maxRunningContainers: 5 };

describe('selectPoolMember ladder', () => {
	it('prefers a warm container that last served this task', () => {
		// The common case rather than an optimization: the wakeup model gives a
		// task many runs, and its worktree and node_modules are already built.
		const decision = selectPoolMember(
			'task-1',
			[member('other'), member('affine', { lastTaskId: 'task-1' })],
			ROOM,
		);
		expect(decision).toEqual({ kind: 'reuse', member: expect.objectContaining({ id: 'affine' }) });
	});

	it('falls back to any warm container', () => {
		const decision = selectPoolMember('task-1', [member('warm')], ROOM);
		expect(decision.kind).toBe('reuse');
	});

	it('resumes a suspended container when none is warm', () => {
		const decision = selectPoolMember('task-1', [member('cold', { state: 'suspended' })], ROOM);
		expect(decision).toEqual({ kind: 'resume', member: expect.objectContaining({ id: 'cold' }) });
	});

	it('creates when the pool is empty', () => {
		expect(selectPoolMember('task-1', [], ROOM)).toEqual({ kind: 'create' });
	});

	it('queues when the cap is reached', () => {
		expect(selectPoolMember('task-1', [], FULL)).toEqual({ kind: 'queue' });
	});

	it('queues rather than resuming past the cap', () => {
		// Resuming does not exempt a container from the cap - otherwise a fleet of
		// suspended containers could be woken straight through it.
		const decision = selectPoolMember('t', [member('cold', { state: 'suspended' })], FULL);
		expect(decision).toEqual({ kind: 'queue' });
	});

	it('reuses a warm container even at the cap, since it is already counted', () => {
		expect(selectPoolMember('t', [member('warm')], FULL).kind).toBe('reuse');
	});

	it('works with no task, where there is nothing to be affine to', () => {
		expect(selectPoolMember(null, [member('warm', { lastTaskId: 'other' })], ROOM).kind).toBe(
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
		);
		expect(decision).toEqual({ kind: 'create' });
	});

	it('never hands the chat’s container to a task run', () => {
		// A queued task run is invisible and harmless; a queued chat turn is a
		// person watching a spinner.
		const decision = selectPoolMember('t', [member('chat', { reservedForChat: true })], ROOM);
		expect(decision).toEqual({ kind: 'create' });
	});

	it('never reuses a container that is out of disk', () => {
		// It would fail its run partway through, which is worse than paying for a
		// fresh one.
		const decision = selectPoolMember('t', [member('full', { atDiskCeiling: true })], ROOM);
		expect(decision).toEqual({ kind: 'create' });
	});

	it('queues rather than taking an excluded container when the cap is reached', () => {
		const decision = selectPoolMember(
			't',
			[member('busy', { state: 'busy' }), member('chat', { reservedForChat: true })],
			FULL,
		);
		expect(decision).toEqual({ kind: 'queue' });
	});

	it('prefers a usable container over an affine one that is busy', () => {
		const decision = selectPoolMember(
			'task-1',
			[member('affine-busy', { state: 'busy', lastTaskId: 'task-1' }), member('free')],
			ROOM,
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

	it('never touches a container holding unpushed commits', () => {
		// The work exists nowhere else, and nothing downstream would report that
		// it had gone.
		const plan = planIdleShutdown([member('risky', { hasUnpushedCommits: true })]);
		expect(plan.suspend).toBeNull();
		expect(plan.destroy).toEqual([]);
	});

	it('suspends a safe container while leaving a risky one alone', () => {
		const plan = planIdleShutdown([member('risky', { hasUnpushedCommits: true }), member('safe')]);
		expect(plan.suspend?.id).toBe('safe');
		expect(plan.destroy).toEqual([]);
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
