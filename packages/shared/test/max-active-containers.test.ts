import { describe, expect, it } from 'vitest';
import { computeDefaultMaxActiveContainers } from '../src/constants';

const GIB = 1024 ** 3;

describe('computeDefaultMaxActiveContainers', () => {
	it('divides total virtual memory by the ram cap (8GB / 2GB = 4)', () => {
		expect(computeDefaultMaxActiveContainers(2 * GIB, 6 * GIB, 2)).toBe(4);
	});

	it('rounds the total before dividing — the 1.92GiB + 6GiB reference host yields 4', () => {
		// A "2GB" droplet reports ~1.92GiB MemTotal; 1.92 + 6 = 7.92 rounds to 8.
		expect(computeDefaultMaxActiveContainers(1.92 * GIB, 6 * GIB, 2)).toBe(4);
	});

	it('scales with the cap — the same host with a 4GB cap yields 2', () => {
		expect(computeDefaultMaxActiveContainers(2 * GIB, 6 * GIB, 4)).toBe(2);
	});

	it('never returns below the minimum, even when the cap exceeds host memory', () => {
		expect(computeDefaultMaxActiveContainers(1 * GIB, 0, 2)).toBe(1);
		expect(computeDefaultMaxActiveContainers(0.5 * GIB, 0, 8)).toBe(1);
	});

	it('clamps to the maximum on huge hosts', () => {
		expect(computeDefaultMaxActiveContainers(512 * GIB, 0, 1)).toBe(100);
	});

	it('treats swap as zero when absent', () => {
		expect(computeDefaultMaxActiveContainers(16 * GIB, 0, 2)).toBe(8);
	});

	it('guards a zero/invalid cap by treating it as 1', () => {
		expect(computeDefaultMaxActiveContainers(8 * GIB, 0, 0)).toBe(8);
	});
});
