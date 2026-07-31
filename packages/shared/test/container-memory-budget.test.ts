import { describe, expect, it } from 'vitest';
import {
	computeDefaultMaxContainerMemoryGb,
	MAX_CONTAINER_MEMORY_GB_MIN,
	projectMemoryFitsBudget,
} from '../src/constants';

const gib = (n: number) => n * 1024 ** 3;

/**
 * The budget replaces a container count because a count only bounds memory while
 * every container is the same size - and `projects.memory_limit_gib` exists so
 * they are not.
 */
describe('computeDefaultMaxContainerMemoryGb', () => {
	it('holds back the system reserve and one container for the chat', () => {
		// 16 GiB RAM, no swap, 2 GB cap: 16 - 1 (system) - 2 (chat) = 13.
		expect(computeDefaultMaxContainerMemoryGb(gib(16), 0, 2)).toBe(13);
	});

	it('counts swap at full weight', () => {
		// The documented reference host: 1.92 GiB RAM + 6 GiB swap, 2 GB cap.
		// round(7.92) = 8, less 1 system and 2 chat = 5.
		expect(computeDefaultMaxContainerMemoryGb(gib(1.92), gib(6), 2)).toBe(5);
	});

	it('clamps to the minimum rather than returning zero on a tiny host', () => {
		// A host too small to fit the reserve must still be able to run one
		// container, or the instance can never do anything at all.
		expect(computeDefaultMaxContainerMemoryGb(gib(1), 0, 2)).toBe(MAX_CONTAINER_MEMORY_GB_MIN);
	});

	it('a bigger per-container cap leaves less budget, not more', () => {
		const small = computeDefaultMaxContainerMemoryGb(gib(16), 0, 2);
		const large = computeDefaultMaxContainerMemoryGb(gib(16), 0, 8);
		expect(large).toBeLessThan(small);
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
