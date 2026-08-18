import { describe, expect, it } from 'vitest';
import { CAPACITY_PARK_MAX_MS, credentialWaitMaxMs } from '../src/services/agent-runner';

/**
 * The credential wait and the capacity park look alike and are not the same
 * judgement: the park waits for a container slot the idle cron frees in seconds,
 * this queues behind a whole other run. They shared a ceiling until they didn't.
 */
describe('credentialWaitMaxMs', () => {
	it("scales with the waiting run's own timeout", () => {
		// 80% of the run's budget, so the wait always leaves the run room to finish.
		expect(credentialWaitMaxMs(10)).toBe(8 * 60_000);
		expect(credentialWaitMaxMs(5)).toBe(4 * 60_000);
	});

	it('never outlives the wall-clock timer that would finalize the run timed_out', () => {
		// The regression guard. An earlier revision floored this at the capacity
		// park's 180s, which for a short agent timeout produced a wait LONGER than
		// launchTask's timer - so the run was killed as `timed_out` instead of
		// handing its work back, trading one errored row for another. That is the
		// exact outcome the fraction exists to avoid, so it must hold at every
		// setting, including the minimum the UI allows.
		for (const runTimeoutMin of [1, 2, 3, 5, 10, 60, 240]) {
			const wallClockMs = runTimeoutMin * 60_000;
			expect(credentialWaitMaxMs(runTimeoutMin)).toBeLessThan(wallClockMs);
		}
	});

	it('is capped, because the waiter holds a container reservation for the whole wait', () => {
		// A dispatch with no spare container reserves memory budget before
		// launchTask and holds it until the run settles, so an unbounded wait is an
		// unbounded charge against every other project's dispatch.
		expect(credentialWaitMaxMs(600)).toBe(15 * 60_000);
		expect(credentialWaitMaxMs(10_000)).toBe(15 * 60_000);
	});

	it('handles a missing or zero timeout without producing a negative or NaN wait', () => {
		// `run_timeout_min` is read from a row that may not be there.
		expect(credentialWaitMaxMs(undefined)).toBe(0);
		expect(credentialWaitMaxMs(null)).toBe(0);
		expect(credentialWaitMaxMs(0)).toBe(0);
	});

	it('no longer shares the capacity park ceiling', () => {
		// Pins the split itself: if someone re-floors this at the park's constant,
		// the invariant above breaks again for short timeouts.
		expect(credentialWaitMaxMs(1)).not.toBe(CAPACITY_PARK_MAX_MS);
	});
});
