import { describe, expect, it } from 'vitest';
import { forEachConcurrent, mapConcurrent } from '../src/lib/concurrency';

describe('mapConcurrent', () => {
	it('returns results in input order regardless of completion order', async () => {
		const out = await mapConcurrent([30, 10, 20, 0], 2, async (ms, i) => {
			await new Promise((r) => setTimeout(r, ms));
			return `${i}:${ms}`;
		});
		expect(out).toEqual(['0:30', '1:10', '2:20', '3:0']);
	});

	// The reason this exists: `Promise.all(rows.map(fn))` starts every task at
	// once, which buys no parallelism when they all queue behind one database
	// and can bury a socket or an upstream API.
	it('never exceeds the requested concurrency', async () => {
		let inFlight = 0;
		let peak = 0;
		await mapConcurrent(
			Array.from({ length: 20 }, (_, i) => i),
			3,
			async () => {
				inFlight++;
				peak = Math.max(peak, inFlight);
				await new Promise((r) => setTimeout(r, 5));
				inFlight--;
			},
		);
		expect(peak).toBeLessThanOrEqual(3);
		expect(peak).toBeGreaterThan(1);
	});

	it('handles an empty input without starting a worker', async () => {
		expect(await mapConcurrent([], 4, async () => 1)).toEqual([]);
	});

	it('propagates a rejection', async () => {
		await expect(
			mapConcurrent([1, 2, 3], 2, async (n) => {
				if (n === 2) throw new Error('boom');
				return n;
			}),
		).rejects.toThrow('boom');
	});

	it('forEachConcurrent runs every item', async () => {
		const seen: number[] = [];
		await forEachConcurrent([1, 2, 3], 2, async (n) => {
			seen.push(n);
		});
		expect(seen.sort()).toEqual([1, 2, 3]);
	});
});
