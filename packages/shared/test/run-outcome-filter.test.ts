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

	it('Succeeded admits the succeeded status and nothing else', () => {
		// Strict, not "everything that did not error": a cancelled or still-queued
		// run under a tab called Succeeded is a lie about what happened.
		for (const s of ALL_STATUSES)
			expect(matchesRunOutcomeFilter(s, RunOutcomeFilter.Succeeded)).toBe(
				s === HeartbeatRunStatus.Succeeded,
			);
	});

	it('Errored admits exactly the errored statuses', () => {
		for (const s of ALL_STATUSES)
			expect(matchesRunOutcomeFilter(s, RunOutcomeFilter.Errored)).toBe(isErroredRunStatus(s));
	});

	it('Succeeded and Errored are disjoint, and All is the only option covering the rest', () => {
		// The three narrow options no longer partition the statuses - a live or
		// cancelled run belongs to neither, which is why All is the default.
		const uncovered = ALL_STATUSES.filter(
			(s) =>
				!matchesRunOutcomeFilter(s, RunOutcomeFilter.Succeeded) &&
				!matchesRunOutcomeFilter(s, RunOutcomeFilter.Errored),
		);
		expect(new Set(uncovered)).toEqual(
			new Set([
				HeartbeatRunStatus.Queued,
				HeartbeatRunStatus.Running,
				HeartbeatRunStatus.Cancelled,
			]),
		);
		for (const s of ALL_STATUSES)
			expect(
				matchesRunOutcomeFilter(s, RunOutcomeFilter.Succeeded) &&
					matchesRunOutcomeFilter(s, RunOutcomeFilter.Errored),
			).toBe(false);
	});
});
