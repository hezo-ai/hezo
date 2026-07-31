import { describe, expect, it } from 'vitest';
import {
	computeDefaultMaxActiveContainers,
	HOST_RESERVED_MEMORY_GB,
	usableMemoryGibForContainers,
} from '../src/constants';

const GIB = 1024 ** 3;

describe('usableMemoryGibForContainers', () => {
	it('withholds the system reserve from total virtual memory', () => {
		expect(usableMemoryGibForContainers(2 * GIB, 6 * GIB)).toBe(8 - HOST_RESERVED_MEMORY_GB);
		expect(usableMemoryGibForContainers(16 * GIB, 0)).toBe(16 - HOST_RESERVED_MEMORY_GB);
	});

	it('never goes negative on a host smaller than the reserve', () => {
		expect(usableMemoryGibForContainers(0.4 * GIB, 0)).toBe(0);
	});

	it('counts swap at full weight', () => {
		// An agent container is idle between execs, so its cold pages really can
		// live on disk and a swap-configured host genuinely fits more containers
		// than its RAM alone. A GiB of swap must buy exactly what a GiB of RAM
		// buys - asserted as an equivalence so a future "swap is worth half"
		// discount fails here rather than quietly halving every host's default.
		expect(usableMemoryGibForContainers(1.92 * GIB, 6 * GIB)).toBe(
			usableMemoryGibForContainers(7.92 * GIB, 0),
		);
	});
});

/**
 * The budget reserves for the host **and** for the chat's container before
 * dividing.
 *
 * Chat is exempt from the limit - a queued task run is invisible and harmless,
 * while a queued chat turn is a person watching a spinner - so peak container
 * count is N + 1 and the extra cap has to come out of the budget. Reserving it
 * up front rather than subtracting when a session opens keeps task-run capacity
 * a stable number: opening the chat never silently slows the fleet.
 */
describe('computeDefaultMaxActiveContainers', () => {
	it('reserves the system and the chat container before dividing ((8 - 1 - 2) / 2 = 2)', () => {
		expect(computeDefaultMaxActiveContainers(2 * GIB, 6 * GIB, 2)).toBe(2);
	});

	it('rounds the total before reserving — the 1.92GiB + 6GiB reference host yields 2', () => {
		// A "2GB" droplet reports ~1.92GiB MemTotal; 1.92 + 6 = 7.92 rounds to 8,
		// less the 1GiB host reserve and one 2GB chat container leaves 5, and
		// floor(5 / 2) = 2.
		expect(computeDefaultMaxActiveContainers(1.92 * GIB, 6 * GIB, 2)).toBe(2);
	});

	it('reserves for the system rather than handing the whole host to containers', () => {
		// Without any reserve this yielded 8 containers x 2GB = all 16GB, leaving
		// nothing for the OS, the Hezo process or the embedded database.
		expect(computeDefaultMaxActiveContainers(16 * GIB, 0, 2)).toBe(6);
	});

	it('scales with the cap — the same 16GB host with a 4GB cap yields 2', () => {
		expect(computeDefaultMaxActiveContainers(16 * GIB, 0, 4)).toBe(2);
	});

	it('reserves exactly one cap for chat, on top of the flat host reserve', () => {
		// Stated as arithmetic rather than a magic number so a change to either
		// reserve fails here rather than silently shifting every host's default.
		const totalGib = 32;
		const cap = 2;
		const expected = Math.floor((totalGib - HOST_RESERVED_MEMORY_GB - cap) / cap);
		expect(computeDefaultMaxActiveContainers(totalGib * GIB, 0, cap)).toBe(expected);
	});

	it('never returns below the minimum, even when the reserves consume the host', () => {
		// A host too small to fit the reserves clamps to 1 rather than returning 0
		// or a negative, which would make the instance run nothing at all.
		expect(computeDefaultMaxActiveContainers(1 * GIB, 0, 2)).toBe(1);
		expect(computeDefaultMaxActiveContainers(0.5 * GIB, 0, 8)).toBe(1);
		expect(computeDefaultMaxActiveContainers(0, 0, 2)).toBe(1);
		expect(computeDefaultMaxActiveContainers(2 * GIB, 0, 2)).toBe(1);
	});

	it('clamps to the maximum on huge hosts', () => {
		expect(computeDefaultMaxActiveContainers(512 * GIB, 0, 1)).toBe(100);
	});

	it('treats swap as zero when absent', () => {
		expect(computeDefaultMaxActiveContainers(9 * GIB, 0, 2)).toBe(3);
	});

	it('counts swap at full weight, including on the reference host', () => {
		expect(computeDefaultMaxActiveContainers(1.92 * GIB, 6 * GIB, 2)).toBe(
			computeDefaultMaxActiveContainers(7.92 * GIB, 0, 2),
		);
		// It is load-bearing there: without its swap the same box fits nothing but
		// the reserves and clamps to the minimum, and more swap keeps buying
		// capacity rather than saturating.
		expect(computeDefaultMaxActiveContainers(1.92 * GIB, 0, 2)).toBe(1);
		expect(computeDefaultMaxActiveContainers(1.92 * GIB, 14 * GIB, 2)).toBe(6);
	});

	it('guards a zero/invalid cap by treating it as 1', () => {
		expect(computeDefaultMaxActiveContainers(8 * GIB, 0, 0)).toBe(6);
	});
});
