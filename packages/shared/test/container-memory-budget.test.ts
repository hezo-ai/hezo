import { describe, expect, it } from 'vitest';
import {
	computeDefaultMaxContainerMemoryGb,
	DEFAULT_MAX_CONTAINER_MEMORY_GB,
	MAX_CONTAINER_MEMORY_GB_MIN,
	minTotalContainerMemoryGb,
	projectMemoryFitsBudget,
	taskContainerMemoryBudgetGb,
} from '../src/constants';

const gib = (n: number) => n * 1024 ** 3;

/** Host memory as an engine whose containers run here would report it. */
const onHost = (ramGib: number, swapGib = 0) => ({
	totalRamBytes: gib(ramGib),
	totalSwapBytes: gib(swapGib),
});

/** The two figures, as every caller sees them: a total, and the task share of it. */
const budgets = (ramGib: number, swapGib: number, capGb: number) => {
	const total = computeDefaultMaxContainerMemoryGb(onHost(ramGib, swapGib), capGb);
	return { total, task: taskContainerMemoryBudgetGb(total, capGb) };
};

/**
 * The budget replaces a container count because a count only bounds memory while
 * every container is the same size - and `projects.memory_limit_gib` exists so
 * they are not.
 *
 * **Two figures, and keeping them apart is most of what these tests are for.**
 * `computeDefaultMaxContainerMemoryGb` returns the TOTAL every container may
 * hold; `taskContainerMemoryBudgetGb` takes one container's worth off it for the
 * assistant chat, and what remains is what task runs are admitted against. The
 * reservation lives there rather than inside the total so that a hand-set budget
 * reserves exactly as a computed one does.
 */
describe('computeDefaultMaxContainerMemoryGb', () => {
	it('holds back the system reserve, and the chat comes out of the task share', () => {
		// 16 GiB RAM, no swap, 2 GB cap: 16 - 1 (system) = 15 total, less 2 (chat).
		const { total, task } = budgets(16, 0, 2);
		expect(total).toBe(15);
		expect(task).toBe(13);
	});

	it('counts swap at full weight', () => {
		// The documented reference host: 1.92 GiB RAM + 6 GiB swap, 2 GB cap.
		// round(7.92) = 8, less 1 system = 7 total, less 2 chat = 5 for task runs.
		const { total, task } = budgets(1.92, 6, 2);
		expect(total).toBe(7);
		expect(task).toBe(5);
	});

	it('clamps so one task container still fits, rather than returning zero', () => {
		// A host too small to fit the reserve must still be able to run one
		// container, or the instance can never do anything at all. The floor is two
		// caps, not one, because the chat's share comes off the total before a task
		// run is admitted against it.
		const { total, task } = budgets(1, 0, 2);
		expect(total).toBe(minTotalContainerMemoryGb(2));
		expect(task).toBe(2);
		expect(MAX_CONTAINER_MEMORY_GB_MIN).toBeLessThanOrEqual(2);
	});

	it('a bigger per-container cap leaves less for task runs, not more', () => {
		// Asserted on the task share: the total is set by host memory and barely
		// moves with the cap, but the chat's reservation scales with it.
		expect(budgets(16, 0, 8).task).toBeLessThan(budgets(16, 0, 2).task);
	});

	it('ignores host memory entirely when the containers do not run here', () => {
		// The whole point: a managed backend's fleet is bounded by the operator's
		// spend, not by the machine Hezo happens to be installed on. A 128 GiB
		// workstation must not authorise 125 GB of somebody else's hardware, and a
		// tiny VPS must not refuse to schedule anything.
		expect(computeDefaultMaxContainerMemoryGb(null, 2)).toBe(DEFAULT_MAX_CONTAINER_MEMORY_GB);
		expect(computeDefaultMaxContainerMemoryGb(null, 8)).toBe(DEFAULT_MAX_CONTAINER_MEMORY_GB);
	});

	it('leaves the flat default room for three task containers plus the chat', () => {
		// The flat default is a TOTAL, so the chat's share comes out of it like
		// anywhere else. If a future edit starts subtracting the cap from it as
		// well, the task share drops to two containers and this catches it.
		expect(taskContainerMemoryBudgetGb(computeDefaultMaxContainerMemoryGb(null, 2), 2)).toBe(6);
	});
});

describe('taskContainerMemoryBudgetGb', () => {
	it('takes exactly one container off the top', () => {
		expect(taskContainerMemoryBudgetGb(16, 4)).toBe(12);
		expect(taskContainerMemoryBudgetGb(8, 2)).toBe(6);
	});

	it('is deliberately unfloored, so a total that admits nothing says so', () => {
		// Flooring here would hand back the container the reservation just took,
		// over-subscribing by exactly the amount the reservation exists to prevent.
		// The floor belongs on the total, where a person setting it can be told.
		expect(taskContainerMemoryBudgetGb(2, 2)).toBe(0);
		expect(taskContainerMemoryBudgetGb(1, 2)).toBeLessThan(0);
	});

	it('refuses to divide by a nonsensical cap', () => {
		expect(taskContainerMemoryBudgetGb(8, 0)).toBe(7);
	});
});

describe('projectMemoryFitsBudget', () => {
	it('accepts a cap the budget can satisfy, including exactly', () => {
		expect(projectMemoryFitsBudget(4, 8)).toBe(true);
		expect(projectMemoryFitsBudget(8, 8)).toBe(true);
	});

	it('rejects a cap larger than the whole budget', () => {
		// Not a queueing decision: such a container can never be scheduled, so the
		// operator has to learn that when they set it, not by watching a run wait.
		expect(projectMemoryFitsBudget(16, 8)).toBe(false);
	});
});

describe('the computed budget always admits at least one task container', () => {
	// The invariant: the budget is compared against a *whole* container's request,
	// so a task share below the per-container cap admits nothing at all and every
	// run queues `InstanceAtCapacity` forever with nothing naming why. Flooring at
	// MAX_CONTAINER_MEMORY_GB_MIN (1 GB) did precisely that on small hosts, so an
	// ordinary 4 GB VPS could never start a single container.
	it.each([
		['2 GiB, no swap', 2, 0],
		['3 GiB, no swap', 3, 0],
		['4 GiB, no swap', 4, 0],
		['tiny host', 1, 0],
	])('%s fits the default cap', (_label, ram, swap) => {
		const { task } = budgets(ram, swap, 2);
		expect(task).toBeGreaterThanOrEqual(2);
		expect(projectMemoryFitsBudget(2, task)).toBe(true);
	});

	it('floors at whatever the cap actually is, not a constant', () => {
		// A raised cap raises the floor with it - the point is "one container
		// fits", not a particular number of gigabytes.
		const { task } = budgets(2, 0, 8);
		expect(task).toBeGreaterThanOrEqual(8);
		expect(projectMemoryFitsBudget(8, task)).toBe(true);
	});

	it('leaves a host with real headroom exactly as it was', () => {
		// The floor must not become the answer on machines that were fine, and the
		// task share must not move for them either: the reservation changed where it
		// is taken, not how much it is. These are the documented reference host and
		// a workstation, at the figures they produced before that move.
		expect(budgets(1.92, 6, 2).task).toBe(5);
		expect(budgets(16, 0, 2).task).toBe(13);
	});
});
