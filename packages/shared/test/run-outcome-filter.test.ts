import { describe, expect, it } from 'vitest';
import {
	ERRORED_RUN_STATUSES,
	HeartbeatRunStatus,
	isErroredRunStatus,
	isRunOutcomeFilter,
	matchesRunOutcomeFilter,
	RunOutcomeFilter,
} from '../src/types/common';

const ALL_STATUSES = Object.values(HeartbeatRunStatus);

describe('isRunOutcomeFilter', () => {
	it('accepts the three filter values', () => {
		for (const v of Object.values(RunOutcomeFilter)) expect(isRunOutcomeFilter(v)).toBe(true);
	});

	it('rejects anything else, including a neighbouring filter enum value', () => {
		for (const v of [undefined, null, '', 'archived', 'failed', 42, {}])
			expect(isRunOutcomeFilter(v)).toBe(false);
	});
});

describe('isErroredRunStatus', () => {
	it('counts exactly failed and timed_out', () => {
		expect(ERRORED_RUN_STATUSES).toEqual([HeartbeatRunStatus.Failed, HeartbeatRunStatus.TimedOut]);
		const errored = ALL_STATUSES.filter(isErroredRunStatus);
		expect(new Set(errored)).toEqual(new Set(ERRORED_RUN_STATUSES));
	});

	it('does not count a live run, however long it has been waiting', () => {
		// The filter is about the outcome, never about whether a run got going -
		// hiding a queued run would hide the most interesting row on the page.
		expect(isErroredRunStatus(HeartbeatRunStatus.Queued)).toBe(false);
		expect(isErroredRunStatus(HeartbeatRunStatus.Running)).toBe(false);
	});

	it('does not count a cancelled run', () => {
		// A run handed back to the queue for capacity finalizes cancelled; it is
		// not an error and must not be filed as one.
		expect(isErroredRunStatus(HeartbeatRunStatus.Cancelled)).toBe(false);
	});
});

describe('matchesRunOutcomeFilter', () => {
	it('All admits every status', () => {
		for (const s of ALL_STATUSES)
			expect(matchesRunOutcomeFilter(s, RunOutcomeFilter.All)).toBe(true);
	});

	it('Runs and Errored partition the statuses exactly', () => {
		for (const s of ALL_STATUSES) {
			const inRuns = matchesRunOutcomeFilter(s, RunOutcomeFilter.Runs);
			const inErrored = matchesRunOutcomeFilter(s, RunOutcomeFilter.Errored);
			expect(inRuns).toBe(!inErrored);
		}
	});
});
