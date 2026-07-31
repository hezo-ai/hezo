import { describe, expect, it } from 'vitest';
import { computeDefaultMaxActiveContainers, SYSTEM_RESERVE_GB } from '../src/constants';

const GIB = 1024 ** 3;

/**
 * The budget reserves for the host and for the chat's container before dividing.
 *
 * Chat is exempt from the cap - a queued task run is invisible and harmless,
 * while a queued chat turn is a person watching a spinner - but the host still
 * has to fit it. Reserving up front rather than subtracting when a session opens
 * keeps task-run capacity a stable number: opening the chat never silently slows
 * the fleet.
 */
describe('computeDefaultMaxActiveContainers', () => {
	it('reserves the system and the chat container before dividing (8GB → (8-1-2)/2 = 2)', () => {
		expect(computeDefaultMaxActiveContainers(2 * GIB, 6 * GIB, 2)).toBe(2);
	});

	it('rounds the total before dividing — the 1.92GiB + 6GiB reference host yields 2', () => {
		// A "2GB" droplet reports ~1.92GiB MemTotal; 1.92 + 6 = 7.92 rounds to 8.
		// This used to yield 4, which was over-subscribed: it only fit by leaning
		// on swap and by pretending the chat container did not exist.
		expect(computeDefaultMaxActiveContainers(1.92 * GIB, 6 * GIB, 2)).toBe(2);
	});

	it('scales with the cap — the same host with a 4GB cap yields 1', () => {
		// (8 - 1 - 4) / 4 = 0.75, floored to 0, clamped up to the minimum.
		expect(computeDefaultMaxActiveContainers(2 * GIB, 6 * GIB, 4)).toBe(1);
	});

	it('reserves exactly one cap for chat, plus the flat system reserve', () => {
		// Stated as arithmetic rather than a magic number so a change to either
		// reserve fails here rather than silently shifting every host's default.
		const totalGib = 32;
		const cap = 2;
		const expected = Math.floor((totalGib - SYSTEM_RESERVE_GB - cap) / cap);
		expect(computeDefaultMaxActiveContainers(totalGib * GIB, 0, cap)).toBe(expected);
	});

	it('never returns below the minimum, even when the reserve exceeds host memory', () => {
		// A host too small to fit the reserve clamps to 1 rather than returning 0
		// or a negative, which would make the instance run nothing at all.
		expect(computeDefaultMaxActiveContainers(1 * GIB, 0, 2)).toBe(1);
		expect(computeDefaultMaxActiveContainers(0.5 * GIB, 0, 8)).toBe(1);
		expect(computeDefaultMaxActiveContainers(0, 0, 2)).toBe(1);
	});

	it('clamps to the maximum on huge hosts', () => {
		expect(computeDefaultMaxActiveContainers(512 * GIB, 0, 1)).toBe(100);
	});

	it('treats swap as zero when absent', () => {
		expect(computeDefaultMaxActiveContainers(16 * GIB, 0, 2)).toBe(6);
	});

	it('guards a zero/invalid cap by treating it as 1', () => {
		expect(computeDefaultMaxActiveContainers(8 * GIB, 0, 0)).toBe(6);
	});
});
