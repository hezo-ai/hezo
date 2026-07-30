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
});

describe('computeDefaultMaxActiveContainers', () => {
	it('divides the memory left after the system reserve by the ram cap ((8 - 1)GB / 2GB = 3)', () => {
		expect(computeDefaultMaxActiveContainers(2 * GIB, 6 * GIB, 2)).toBe(3);
	});

	it('rounds the total before reserving — the 1.92GiB + 6GiB reference host yields 3', () => {
		// A "2GB" droplet reports ~1.92GiB MemTotal; 1.92 + 6 = 7.92 rounds to 8,
		// less the 1GiB reserve leaves 7, and floor(7 / 2) = 3.
		expect(computeDefaultMaxActiveContainers(1.92 * GIB, 6 * GIB, 2)).toBe(3);
	});

	it('reserves for the system rather than handing the whole host to containers', () => {
		// Without the reserve this yielded 8 containers x 2GB = all 16GB, leaving
		// nothing for the OS, the Hezo process or the embedded database.
		expect(computeDefaultMaxActiveContainers(16 * GIB, 0, 2)).toBe(7);
	});

	it('scales with the cap — the same 16GB host with a 4GB cap yields 3', () => {
		expect(computeDefaultMaxActiveContainers(16 * GIB, 0, 4)).toBe(3);
	});

	it('never returns below the minimum, even when the reserve consumes the host', () => {
		expect(computeDefaultMaxActiveContainers(1 * GIB, 0, 2)).toBe(1);
		expect(computeDefaultMaxActiveContainers(0.5 * GIB, 0, 8)).toBe(1);
		expect(computeDefaultMaxActiveContainers(2 * GIB, 0, 2)).toBe(1);
	});

	it('clamps to the maximum on huge hosts', () => {
		expect(computeDefaultMaxActiveContainers(512 * GIB, 0, 1)).toBe(100);
	});

	it('treats swap as zero when absent', () => {
		expect(computeDefaultMaxActiveContainers(9 * GIB, 0, 2)).toBe(4);
	});

	it('guards a zero/invalid cap by treating it as 1', () => {
		expect(computeDefaultMaxActiveContainers(8 * GIB, 0, 0)).toBe(7);
	});
});
