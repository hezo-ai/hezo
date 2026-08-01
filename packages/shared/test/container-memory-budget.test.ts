import { describe, expect, it } from 'vitest';
import {
	computeDefaultMaxContainerMemoryGb,
	DEFAULT_MAX_CONTAINER_MEMORY_GB,
	MAX_CONTAINER_MEMORY_GB_MIN,
	projectMemoryFitsBudget,
} from '../src/constants';

const gib = (n: number) => n * 1024 ** 3;

/** Host memory as an engine whose containers run here would report it. */
const onHost = (ramGib: number, swapGib = 0) => ({
	totalRamBytes: gib(ramGib),
	totalSwapBytes: gib(swapGib),
});

/**
 * The budget replaces a container count because a count only bounds memory while
 * every container is the same size - and `projects.memory_limit_gib` exists so
 * they are not.
 */
describe('computeDefaultMaxContainerMemoryGb', () => {
	it('holds back the system reserve and one container for the chat', () => {
		// 16 GiB RAM, no swap, 2 GB cap: 16 - 1 (system) - 2 (chat) = 13.
		expect(computeDefaultMaxContainerMemoryGb(onHost(16), 2)).toBe(13);
	});

	it('counts swap at full weight', () => {
		// The documented reference host: 1.92 GiB RAM + 6 GiB swap, 2 GB cap.
		// round(7.92) = 8, less 1 system and 2 chat = 5.
		expect(computeDefaultMaxContainerMemoryGb(onHost(1.92, 6), 2)).toBe(5);
	});

	it('clamps to the minimum rather than returning zero on a tiny host', () => {
		// A host too small to fit the reserve must still be able to run one
		// container, or the instance can never do anything at all.
		expect(computeDefaultMaxContainerMemoryGb(onHost(1), 2)).toBe(MAX_CONTAINER_MEMORY_GB_MIN);
	});

	it('a bigger per-container cap leaves less budget, not more', () => {
		const small = computeDefaultMaxContainerMemoryGb(onHost(16), 2);
		const large = computeDefaultMaxContainerMemoryGb(onHost(16), 8);
		expect(large).toBeLessThan(small);
	});

	it('ignores host memory entirely when the containers do not run here', () => {
		// The whole point: a managed backend's fleet is bounded by the operator's
		// spend, not by the machine Hezo happens to be installed on. A 128 GiB
		// workstation must not authorise 125 GB of somebody else's hardware, and a
		// tiny VPS must not refuse to schedule anything.
		expect(computeDefaultMaxContainerMemoryGb(null, 2)).toBe(DEFAULT_MAX_CONTAINER_MEMORY_GB);
		expect(computeDefaultMaxContainerMemoryGb(null, 8)).toBe(DEFAULT_MAX_CONTAINER_MEMORY_GB);
	});

	it('does not subtract the chat reserve twice on a managed backend', () => {
		// The flat default is already the task-run figure - see the docstring. If a
		// future edit starts subtracting the cap from it as well, this catches it.
		expect(computeDefaultMaxContainerMemoryGb(null, 2)).toBeGreaterThan(
			DEFAULT_MAX_CONTAINER_MEMORY_GB - 2,
		);
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
